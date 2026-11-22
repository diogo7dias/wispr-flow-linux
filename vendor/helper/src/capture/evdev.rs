//! evdev key capture — reads `/dev/input/event*` directly.
//!
//! Sits below the display server, so it works identically on Wayland and X11
//! (the read-side mirror of the [uinput injection](crate::backend) write path).
//! Needs read access to the input devices: the logind `uaccess` ACL (granted to
//! the active session on most desktops) or membership in the `input` group.
//! Without it no device is readable and capture is a no-op (with a warning) —
//! `wispr-flow --doctor` and the shipped udev rule address this.

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use super::{emit_keypress, HeldKeys};
use crate::backend::EventSink;
use crate::keymap;

// evdev event type / key-state values (<linux/input-event-codes.h>).
const EV_KEY: u16 = 0x01;
const KEY_PRESS: i32 = 1;
const KEY_RELEASE: i32 = 0;
// Representative keys used to distinguish a real keyboard from a mouse/gamepad
// (which carry BTN_* codes but not letter keys).
const KEY_A: u16 = 30;
const KEY_Z: u16 = 44;

// Widest keycode we map; a (KEY_MAX/8 + 1)-byte bitmap covers every code.
const KEY_MAX: usize = 0x2ff;
const BITMAP_LEN: usize = (KEY_MAX / 8) + 1;

// ioctl request numbers (asm-generic `_IOC` encoding, shared by x86_64/aarch64):
//   _IOC(dir, type, nr, size) = (dir<<30) | (size<<16) | (type<<8) | nr
// `'E'` (0x45) is the evdev ioctl group. Both reads, so dir = _IOC_READ = 2.
const fn ioc_read(nr: u64, size: u64) -> libc::c_ulong {
    ((2u64 << 30) | (size << 16) | (0x45u64 << 8) | nr) as libc::c_ulong
}
// EVIOCGKEY(len): global state bitmap of currently-pressed keys.  nr = 0x18
const fn eviocgkey() -> libc::c_ulong {
    ioc_read(0x18, BITMAP_LEN as u64)
}
// EVIOCGBIT(EV_KEY, len): capability bitmap of the keys a device can emit.
//   nr = 0x20 + ev_type  → 0x21 for EV_KEY
const fn eviocgbit_key() -> libc::c_ulong {
    ioc_read(0x20 + EV_KEY as u64, BITMAP_LEN as u64)
}

fn bit_set(bitmap: &[u8], code: u16) -> bool {
    let (byte, bit) = (code as usize / 8, code as u32 % 8);
    byte < bitmap.len() && (bitmap[byte] >> bit) & 1 == 1
}

fn is_event_node(path: &Path) -> bool {
    path.file_name().and_then(|s| s.to_str()).is_some_and(|n| {
        n.strip_prefix("event")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()))
    })
}

/// True if the open device advertises ordinary keyboard keys (KEY_A..KEY_Z),
/// which filters out mice, touchpads, and other non-keyboard event nodes.
fn is_keyboard(fd: libc::c_int) -> bool {
    // Never capture our injected paste keystrokes as user shortcuts.
    let mut name = [0u8; 256];
    if unsafe { libc::ioctl(fd, ioc_read(0x06, 256), name.as_mut_ptr()) } >= 0
        && is_own_keyboard(&name)
    {
        return false;
    }
    let mut bitmap = [0u8; BITMAP_LEN];
    if unsafe { libc::ioctl(fd, eviocgbit_key(), bitmap.as_mut_ptr()) } < 0 {
        return false;
    }
    bit_set(&bitmap, KEY_A) && bit_set(&bitmap, KEY_Z)
}

fn is_own_keyboard(name: &[u8]) -> bool {
    name.starts_with(b"Wispr Flow Linux Helper\0")
}

/// Open every readable keyboard under `/dev/input`, returning `(path, file)`
/// pairs with blocking fds ready for `read`. Empty when none are readable.
fn open_keyboards() -> Vec<(PathBuf, File)> {
    let dir = match std::fs::read_dir("/dev/input") {
        Ok(d) => d,
        Err(e) => {
            log::warn!("evdev capture: cannot read /dev/input: {e}");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in dir.flatten() {
        let path = entry.path();
        if !is_event_node(&path) {
            continue;
        }
        // Blocking fd: open() never blocks on evdev, but read() must, so the
        // per-device thread can park until the next key event.
        let file = match OpenOptions::new().read(true).open(&path) {
            Ok(f) => f,
            Err(_) => continue, // not readable -> skip (permission or busy)
        };
        if is_keyboard(file.as_raw_fd()) {
            out.push((path, file));
        }
    }
    out
}

/// Start evdev capture: one reader thread per keyboard. Returns a [`HeldKeys`]
/// handle, or `None` when no device is readable (so the caller can fall back).
pub fn start(events: EventSink) -> Option<Box<dyn HeldKeys>> {
    let index = Arc::new(AtomicU64::new(0));
    let pid = std::process::id();
    let result = std::thread::Builder::new()
        .name("keyboard-hotplug".into())
        .spawn(move || {
            let mut readers: HashMap<(u64, u64), std::thread::JoinHandle<()>> = HashMap::new();
            loop {
                readers.retain(|_, thread| !thread.is_finished());
                for (path, file) in open_keyboards() {
                    let Ok(meta) = file.metadata() else { continue };
                    let identity = (meta.rdev(), meta.ino());
                    if readers.contains_key(&identity) || readers.len() >= 64 {
                        continue;
                    }
                    let events = events.clone();
                    let index = index.clone();
                    if let Ok(thread) = std::thread::Builder::new()
                        .name("key-capture-evdev".into())
                        .spawn(move || read_device(&path, file, &events, &index, pid))
                    {
                        readers.insert(identity, thread);
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    if result.is_err() {
        return None;
    }
    log::info!("keyboard hotplug monitor ready");
    Some(Box::new(EvdevHeld))
}

/// Blocking read loop for one device: decode `input_event`s and emit a
/// `KeypressEvent` for every key press/release (auto-repeat is ignored).
fn read_device(path: &Path, mut file: File, events: &EventSink, index: &AtomicU64, pid: u32) {
    let evsize = std::mem::size_of::<libc::input_event>();
    let mut buf = vec![0u8; evsize * 64];
    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => {
                log::info!("evdev capture: {} closed (EOF)", path.display());
                return;
            }
            Ok(n) => n,
            Err(e) => {
                // ENODEV on unplug, etc. Drop this device; others keep running.
                log::info!("evdev capture: {} read ended: {e}", path.display());
                return;
            }
        };
        // The kernel only ever returns whole `input_event`s; guard the slice
        // regardless in case of a short trailing read.
        let mut off = 0;
        while off + evsize <= n {
            // SAFETY: a `Vec<u8>` is byte-aligned, so read the struct unaligned.
            let ev: libc::input_event =
                unsafe { std::ptr::read_unaligned(buf.as_ptr().add(off) as *const _) };
            off += evsize;
            if ev.type_ != EV_KEY {
                continue;
            }
            let press = match ev.value {
                KEY_PRESS => true,
                KEY_RELEASE => false,
                _ => continue, // skip auto-repeat (value == 2)
            };
            let Some(vk) = keymap::evdev_to_vk(ev.code) else {
                continue; // unmapped physical key — nothing the app understands
            };
            emit_keypress(events, index, pid, vk, press);
        }
    }
}

/// Stale-key querier backed by `EVIOCGKEY` across all readable event devices.
struct EvdevHeld;

impl HeldKeys for EvdevHeld {
    fn held_vks(&self) -> HashSet<u32> {
        let mut held = HashSet::new();
        let dir = match std::fs::read_dir("/dev/input") {
            Ok(d) => d,
            Err(_) => return held,
        };
        for entry in dir.flatten() {
            let path = entry.path();
            if !is_event_node(&path) {
                continue;
            }
            let file = match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path)
            {
                Ok(f) => f,
                Err(_) => continue,
            };
            let mut bitmap = [0u8; BITMAP_LEN];
            if unsafe { libc::ioctl(file.as_raw_fd(), eviocgkey(), bitmap.as_mut_ptr()) } < 0 {
                continue;
            }
            for code in 0..=KEY_MAX as u16 {
                if bit_set(&bitmap, code) {
                    if let Some(vk) = keymap::evdev_to_vk(code) {
                        held.insert(vk);
                    }
                }
            }
        }
        held
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn event_names_are_numeric_nodes_only() {
        for name in ["event0", "event23"] {
            assert!(is_event_node(Path::new(name)));
        }
        for name in ["event", "event-copy", "mouse0"] {
            assert!(!is_event_node(Path::new(name)));
        }
    }
    #[test]
    fn injected_keyboard_is_excluded_from_hotplug_capture() {
        assert!(is_own_keyboard(b"Wispr Flow Linux Helper\0padding"));
        assert!(!is_own_keyboard(b"External keyboard\0"));
    }

    #[test]
    #[ignore = "creates a temporary keyboard, without injecting keys; needs active-seat uinput access"]
    fn discovers_keyboard_added_after_start_and_reconnected() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let _held = start(tx).unwrap();
        let name = format!("Wispr hotplug test {}", std::process::id());
        for _ in 0..2 {
            let device = crate::backend::uinput::UInput::create_named(name.as_bytes()).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
            let node = loop {
                let found = std::fs::read_dir("/sys/class/input")
                    .unwrap()
                    .flatten()
                    .find_map(|e| {
                        if !is_event_node(&e.path()) {
                            return None;
                        }
                        let actual = std::fs::read_to_string(e.path().join("device/name")).ok()?;
                        (actual.trim() == name)
                            .then(|| PathBuf::from("/dev/input").join(e.file_name()))
                    });
                if let Some(node) = found {
                    let opened = std::fs::read_dir("/proc/self/fd")
                        .unwrap()
                        .flatten()
                        .any(|fd| std::fs::read_link(fd.path()).ok().as_ref() == Some(&node));
                    if opened {
                        break node;
                    }
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "hotplug reader was not acquired"
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
            };
            drop(device);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
            while std::fs::read_dir("/proc/self/fd")
                .unwrap()
                .flatten()
                .any(|fd| std::fs::read_link(fd.path()).ok().as_ref() == Some(&node))
            {
                assert!(
                    std::time::Instant::now() < deadline,
                    "unplugged reader did not close"
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}

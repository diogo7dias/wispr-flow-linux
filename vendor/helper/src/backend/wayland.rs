//! Wayland backend.
//!
//! Injection uses an in-process uinput virtual keyboard (`uinput.rs`) — real
//! kernel input events the compositor routes to the focused surface, which is
//! the only compositor-agnostic way to synthesize input on Wayland (XTEST does
//! not reach native Wayland windows). Clipboard preservation and rich offers
//! use the in-process ext-data-control client.
//!
//! Implemented:
//!   * PasteText        — preserve clipboard, guarded uinput paste, restore
//!   * SimulateKeyPress — VK -> evdev (keymap.rs) -> uinput chord
//!   * GetSelectedText  — non-destructive accessibility read only
//!   * GetAccessibilityStatus — true when uinput is usable
//!
//! Best-effort / known gaps (Wayland exposes almost nothing here without
//! compositor-specific D-Bus/portal calls):
//!   * GetActiveAppInfo / GetRunningApps — no portable protocol; returns empty.
//!     KDE could be wired via KWin D-Bus and GNOME via a shell extension later.
//!   * Focus checks guard the Hyprland window identity, not individual text
//!     fields. There is no atomic focus-check-and-inject Wayland operation.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::uinput::UInput;
use super::{ActiveApp, Backend, Result, RunningApp, Selection};
use crate::keymap;

/// Wayland injection + clipboard + selection. Active-app identity is **not**
/// handled here: `detect()` selects an `ActiveAppProvider` (KWin / GNOME ext /
/// AT-SPI) independently and composes it on top, so this backend stays a pure,
/// compositor-agnostic injector. The active-app methods below therefore return
/// empty / no-op (the composing layer supplies identity from the provider).
pub struct WaylandBackend {
    uinput: UInput,
}

impl WaylandBackend {
    pub fn connect() -> Result<WaylandBackend> {
        let uinput = UInput::create()?;
        log::info!("wayland clipboard safety: preserve formats, guard focus, no copy probe");
        Ok(WaylandBackend { uinput })
    }
}

impl Backend for WaylandBackend {
    fn paste_text(&mut self, text: &str, html: Option<&str>) -> Result<()> {
        let target = focused_window()?;
        let mut offers = vec![("text/plain;charset=utf-8".into(), text.as_bytes().to_vec())];
        if let Some(html) = html {
            offers.push(("text/html".into(), html.as_bytes().to_vec()));
        }
        super::wl_clipboard::with_clipboard(offers, |owned| {
            // Re-query immediately before injecting, not before slow clipboard
            // reads. On Hyprland, unknown focus fails closed instead of guessing.
            if target != focused_window()? {
                return Err("focus changed; paste cancelled".into());
            }
            if !owned.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("clipboard changed; paste cancelled".into());
            }
            let ctrl = keymap::flag_to_evdev("Control").unwrap();
            let v = keymap::vk_to_evdev(b'V' as u32).ok_or("no evdev for V")?;
            if target.as_ref().is_some_and(|w| w.terminal) {
                let shift = keymap::flag_to_evdev("Shift").unwrap();
                self.uinput.chord(v, &[ctrl, shift])
            } else {
                self.uinput.chord(v, &[ctrl])
            }
        })
    }

    fn simulate_key_press(&mut self, keycode_vk: u32, flags: &[String]) -> Result<()> {
        let key = keymap::vk_to_evdev(keycode_vk)
            .ok_or_else(|| format!("unmapped VK {keycode_vk} (no evdev code)"))?;
        let mods: Vec<u16> = flags
            .iter()
            .filter_map(|f| keymap::flag_to_evdev(f))
            .collect();
        // TODO: snapshot & release physically-held modifiers around injection
        // (mirrors the Windows helper's GetKeyState dance); needs /dev/input read.
        self.uinput.chord(key, &mods)
    }

    fn get_active_app(&mut self) -> Result<ActiveApp> {
        // No native active-app source on Wayland; the composing `ActiveAppProvider`
        // (KWin / GNOME ext / AT-SPI, chosen in `detect()`) supplies identity.
        Ok(ActiveApp::default())
    }

    fn get_running_apps(&mut self) -> Result<Vec<RunningApp>> {
        // See `get_active_app`: supplied by the composing provider.
        Ok(Vec::new())
    }

    fn get_selected_text(&mut self) -> Result<Selection> {
        // A copy probe sends SIGINT in terminals and may return stale clipboard
        // content. Do not synthesize Ctrl+C in a terminal.
        let target = match focused_window() {
            Ok(target) => target,
            Err(_) => return Ok(Selection::default()),
        };
        if target.as_ref().is_some_and(|w| w.terminal) {
            return Ok(Selection::default());
        }
        // Never fall back to Ctrl+C: it can interrupt an app and return stale
        // clipboard contents when there is no selected text.
        match super::atspi_sel::get_selection() {
            Ok(Some(sel)) if focused_window().is_ok_and(|now| now == target) => Ok(sel),
            _ => Ok(Selection::default()),
        }
    }

    fn accessibility_status(&mut self) -> bool {
        // We hold a live uinput device => injection works. (Reading selection via
        // AT-SPI is a separate capability tracked under get_selected_text.)
        true
    }

    fn set_focus_detection(&mut self, _active: bool) {
        // Focus events come from the composing `ActiveAppProvider`, not here.
    }

    fn name(&self) -> &'static str {
        "wayland"
    }
}

/// Heuristic: is this a KDE Plasma session (so the KWin scripting bridge is
/// worth trying)? Checks the standard desktop-environment env vars. Used by
/// `mod.rs::pick_active_app_provider`.
pub(crate) fn is_kde() -> bool {
    let probe = |k: &str| std::env::var(k).unwrap_or_default().to_ascii_uppercase();
    probe("XDG_CURRENT_DESKTOP").contains("KDE")
        || probe("XDG_SESSION_DESKTOP").contains("KDE")
        || std::env::var_os("KDE_FULL_SESSION").is_some()
}

fn terminal_window(json: &str) -> bool {
    let Ok(window) = serde_json::from_str::<serde_json::Value>(json) else {
        return false;
    };
    let class = window["class"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        class.as_str(),
        "foot"
            | "footclient"
            | "alacritty"
            | "kitty"
            | "com.mitchellh.ghostty"
            | "ghostty"
            | "org.wezfurlong.wezterm"
            | "wezterm"
            | "org.gnome.terminal"
            | "gnome-terminal-server"
            | "konsole"
            | "org.kde.konsole"
            | "tilix"
            | "terminator"
    )
}

#[derive(Debug, PartialEq, Eq)]
struct FocusedWindow {
    address: String,
    pid: u64,
    class: String,
    terminal: bool,
}

fn parse_focus(json: &str) -> Result<FocusedWindow> {
    let window: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "invalid focus response")?;
    let address = window["address"]
        .as_str()
        .filter(|s| s.starts_with("0x") && s.len() > 2 && *s != "0x0")
        .ok_or("no focused window")?
        .to_owned();
    let pid = window["pid"]
        .as_u64()
        .filter(|p| *p > 0)
        .ok_or("invalid focused PID")?;
    let class = window["class"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("unknown focused app")?
        .to_owned();
    Ok(FocusedWindow {
        address,
        pid,
        class,
        terminal: terminal_window(json),
    })
}

fn focused_window() -> Result<Option<FocusedWindow>> {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
        return Ok(None);
    }
    parse_focus(&run_capture("hyprctl", &["activewindow", "-j"])?).map(Some)
}

/// Run `prog args`, capturing stdout, but never block the (single-threaded)
/// dispatch loop forever: if the child doesn't finish within `CAPTURE_TIMEOUT`
/// it's killed and we return an error. `wl-paste` can hang on some compositors
/// (e.g. mutter has no ext/wlr-data-control and a misbehaving selection owner
/// can stall the read), which would otherwise freeze every subsequent command.
const CAPTURE_TIMEOUT: Duration = Duration::from_millis(1500);

fn run_capture(prog: &str, args: &[&str]) -> Result<String> {
    let mut child = Command::new(prog)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn {prog}: {e}"))?;

    // Drain stdout on a helper thread so a child that fills the pipe can't
    // deadlock; killing the child on timeout closes the pipe and unblocks it.
    let mut stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let buf = rx
                    .recv_timeout(Duration::from_millis(200))
                    .unwrap_or_default();
                if !status.success() {
                    return Err(format!("{prog} exited with {status}"));
                }
                return Ok(String::from_utf8_lossy(&buf).into_owned());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{prog} timed out after {CAPTURE_TIMEOUT:?}"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("wait {prog}: {e}")),
        }
    }
}

#[cfg(test)]
mod terminal_tests {
    use super::{parse_focus, terminal_window};

    #[test]
    fn focus_identity_rejects_unknown_and_distinguishes_same_app_windows() {
        for json in [
            "{}",
            "invalid",
            r#"{"address":"0x0","pid":123,"class":"foot"}"#,
        ] {
            assert!(parse_focus(json).is_err());
        }
        let a = parse_focus(r#"{"address":"0x123","pid":123,"class":"foot"}"#).unwrap();
        let b = parse_focus(r#"{"address":"0x456","pid":123,"class":"foot"}"#).unwrap();
        assert_ne!(a, b);
        assert!(a.terminal);
    }

    #[test]
    fn detects_terminals_by_class_not_title() {
        assert!(terminal_window(r#"{"class":"foot"}"#));
        assert!(terminal_window(r#"{"class":"Alacritty"}"#));
        assert!(terminal_window(r#"{"class":"com.mitchellh.ghostty"}"#));
        assert!(!terminal_window(r#"{"class":"chromium","title":"foot"}"#));
        assert!(!terminal_window("{}"));
        assert!(!terminal_window("invalid"));
    }
}

//! In-process Wayland clipboard owner (ext-data-control).
//!
//! `wl-copy` can only serve a single payload, so it can't offer a plain-text and
//! an HTML representation of the same paste simultaneously. The Windows helper
//! sets two formats at once (CF_UNICODETEXT + CF_TEXT); to match that — and to
//! offer `text/html` for rich targets — we own the selection ourselves.
//!
//! We use `ext_data_control_manager_v1` (the standardized successor to wlroots'
//! `zwlr_data_control`), which lets a non-focused client set/own the clipboard
//! without an input-event serial. KWin/wlroots/etc. advertise it. On a session
//! that lacks it, paste fails without a destructive plain-text fallback.
//!
//! Each transaction snapshots the current formats in memory, offers dictation,
//! invokes paste, and restores the snapshot after a grace period unless another
//! owner took the clipboard. Restored content is served until the next copy.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use wayland_client::backend::ObjectId;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::protocol::wl_seat::WlSeat;
use wayland_client::{event_created_child, Connection, Dispatch, EventQueue, Proxy, QueueHandle};
use wayland_protocols::ext::data_control::v1::client::ext_data_control_device_v1::ExtDataControlDeviceV1;
use wayland_protocols::ext::data_control::v1::client::ext_data_control_manager_v1::ExtDataControlManagerV1;
use wayland_protocols::ext::data_control::v1::client::ext_data_control_offer_v1::ExtDataControlOfferV1;
use wayland_protocols::ext::data_control::v1::client::ext_data_control_source_v1::{
    Event as SourceEvent, ExtDataControlSourceV1,
};

use super::Result;

/// A MIME type plus the bytes to serve for it.
pub type Offer = (String, Vec<u8>);

struct State {
    offers: Vec<Offer>,
    cancelled: bool,
    active_source: Option<ObjectId>,
    selection: Option<ExtDataControlOfferV1>,
    types: HashMap<ObjectId, Vec<String>>,
    generation: u64,
    owned: Arc<AtomicBool>,
    writers: Arc<AtomicUsize>,
}

/// Preserve the clipboard around a paste. The callback runs as soon as the
/// temporary offer is ready; return waits for the restoration grace period.
pub fn with_clipboard(
    offers: Vec<Offer>,
    paste: impl FnOnce(&AtomicBool) -> Result<()>,
) -> Result<()> {
    if offers.is_empty() {
        return Err("no clipboard offers".into());
    }
    let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
    let (finish_tx, finish_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let aborted = Arc::new(AtomicBool::new(false));
    let worker_aborted = aborted.clone();
    let owned = Arc::new(AtomicBool::new(true));
    let worker_owned = owned.clone();
    std::thread::spawn(move || {
        if let Err(e) = setup_and_serve(
            offers,
            &ready_tx,
            finish_rx,
            &done_tx,
            &worker_aborted,
            worker_owned,
        ) {
            // If we failed before signalling ready, report it; if after, log it.
            let _ = ready_tx.send(Err(e.clone()));
            let _ = done_tx.send(Err(e));
        }
    });
    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            aborted.store(true, Ordering::SeqCst);
            return Err("clipboard preparation timed out; paste cancelled".into());
        }
    };
    let result = paste(&owned);
    // Let slow paste targets request all their representations before restoring.
    // ACK follows restoration, preventing overlapping helper paste transactions.
    let _ = finish_tx.send(if result.is_ok() {
        Duration::from_millis(750)
    } else {
        Duration::ZERO
    });
    if !matches!(done_rx.recv_timeout(Duration::from_secs(2)), Ok(Ok(()))) {
        // Do not report a failed paste after injecting: the app could retry it.
        log::warn!("clipboard restoration not confirmed; paste was not retried");
    }
    result
}

fn setup_and_serve(
    offers: Vec<Offer>,
    ready_tx: &mpsc::Sender<Result<()>>,
    finish_rx: mpsc::Receiver<Duration>,
    done_tx: &mpsc::Sender<Result<()>>,
    aborted: &AtomicBool,
    owned: Arc<AtomicBool>,
) -> Result<()> {
    let conn = Connection::connect_to_env().map_err(|e| format!("wl connect: {e}"))?;
    let (globals, mut queue) =
        registry_queue_init::<State>(&conn).map_err(|e| format!("registry init: {e}"))?;
    let qh = queue.handle();

    let manager: ExtDataControlManagerV1 = globals
        .bind(&qh, 1..=1, ())
        .map_err(|e| format!("ext_data_control_manager not available: {e}"))?;
    let seat: WlSeat = globals
        .bind(&qh, 1..=9, ())
        .map_err(|e| format!("wl_seat bind: {e}"))?;

    let device = manager.get_data_device(&seat, &qh, ());
    let mut state = State {
        offers,
        cancelled: false,
        active_source: None,
        selection: None,
        types: HashMap::new(),
        generation: 0,
        owned,
        writers: Arc::new(AtomicUsize::new(0)),
    };
    queue
        .roundtrip(&mut state)
        .map_err(|e| format!("clipboard discovery: {e}"))?;
    let saved = snapshot(&conn, &mut queue, &mut state)?;
    if aborted.load(Ordering::SeqCst) {
        return Err("clipboard preparation cancelled".into());
    }
    let source = manager.create_data_source(&qh, Arc::new(state.offers.clone()));
    for (mime, _) in &state.offers {
        source.offer(mime.clone());
    }
    state.active_source = Some(source.id());
    device.set_selection(Some(&source));
    // Ensure the compositor has processed set_selection before we report ready
    // (so a Ctrl+V immediately after returns the new content).
    queue
        .roundtrip(&mut state)
        .map_err(|e| format!("roundtrip: {e}"))?;
    let _ = ready_tx.send(Ok(()));

    let mut deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(delay) = finish_rx.try_recv() {
            deadline = Instant::now() + delay;
        }
        if aborted.load(Ordering::SeqCst) || Instant::now() >= deadline || state.cancelled {
            break;
        }
        pump(&conn, &mut queue, &mut state)?;
    }
    // Process queued ownership loss before restoring. ext-data-control has no
    // atomic compare-and-set: a final compositor race remains unavoidable.
    queue
        .roundtrip(&mut state)
        .map_err(|e| format!("clipboard ownership check: {e}"))?;
    if state.cancelled {
        let _ = done_tx.send(Ok(()));
        return Ok(()); // A newer user/app copy wins, even if its bytes match ours.
    }
    source.destroy();
    state.offers = saved;
    if state.offers.is_empty() {
        device.set_selection(None);
        conn.flush().map_err(|e| format!("clear clipboard: {e}"))?;
        let _ = done_tx.send(Ok(()));
        return Ok(());
    }
    let restored = manager.create_data_source(&qh, Arc::new(state.offers.clone()));
    for (mime, _) in &state.offers {
        restored.offer(mime.clone());
    }
    state.active_source = Some(restored.id());
    device.set_selection(Some(&restored));
    queue
        .roundtrip(&mut state)
        .map_err(|e| format!("clipboard restore: {e}"))?;
    let _ = done_tx.send(Ok(()));

    // Serve paste (`Send`) requests until the selection is taken from us.
    while !state.cancelled {
        if let Err(e) = queue.blocking_dispatch(&mut state) {
            log::debug!("clipboard dispatch ended: {e}");
            break;
        }
    }
    log::debug!("clipboard source released");
    Ok(())
}

impl Dispatch<ExtDataControlSourceV1, Arc<Vec<Offer>>> for State {
    fn event(
        state: &mut Self,
        src: &ExtDataControlSourceV1,
        event: SourceEvent,
        data: &Arc<Vec<Offer>>,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            SourceEvent::Send { mime_type, fd } => {
                // A target is pasting: write the bytes for the requested type.
                let file = File::from(fd); // OwnedFd -> File (closed on drop)
                if data.iter().any(|(mime, _)| *mime == mime_type)
                    && state.writers.load(Ordering::SeqCst) < 8
                {
                    let offers = data.clone();
                    let writers = state.writers.clone();
                    writers.fetch_add(1, Ordering::SeqCst);
                    // Never let a stalled clipboard consumer block ownership
                    // notifications or the restore timer.
                    std::thread::spawn(move || {
                        if let Some((_, bytes)) = offers.iter().find(|(mime, _)| *mime == mime_type)
                        {
                            let _ = write_bounded(file, bytes);
                        }
                        writers.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
            SourceEvent::Cancelled if state.active_source.as_ref() == Some(&src.id()) => {
                // Selection replaced (by another app or our next set) -> stop.
                state.cancelled = true;
                state.owned.store(false, Ordering::SeqCst);
            }
            _ => {}
        }
    }
}

// The remaining objects have no events we act on, but every proxy needs a
// Dispatch impl for the queue's state type.
impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wayland_client::protocol::wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtDataControlManagerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &ExtDataControlManagerV1,
        _: wayland_protocols::ext::data_control::v1::client::ext_data_control_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtDataControlDeviceV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &ExtDataControlDeviceV1,
        event: wayland_protocols::ext::data_control::v1::client::ext_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use wayland_protocols::ext::data_control::v1::client::ext_data_control_device_v1::Event;
        match event {
            Event::Selection { id } => {
                state.generation += 1;
                if let Some(old) = state.selection.take() {
                    state.types.remove(&old.id());
                    old.destroy();
                }
                state.selection = id;
            }
            Event::PrimarySelection { id: Some(offer) } => {
                state.types.remove(&offer.id());
                offer.destroy();
            }
            Event::Finished => {
                state.cancelled = true;
            }
            _ => {}
        }
    }
    // The device's `data_offer` event (opcode 0) creates a child offer object
    // describing some *other* selection; declare its user-data so wayland-client
    // can construct it (otherwise it panics), then ignore it below.
    event_created_child!(State, ExtDataControlDeviceV1, [
        0 => (ExtDataControlOfferV1, ()),
    ]);
}

impl Dispatch<ExtDataControlOfferV1, ()> for State {
    fn event(
        state: &mut Self,
        offer: &ExtDataControlOfferV1,
        event: wayland_protocols::ext::data_control::v1::client::ext_data_control_offer_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wayland_protocols::ext::data_control::v1::client::ext_data_control_offer_v1::Event::Offer { mime_type } = event {
            state.types.entry(offer.id()).or_default().push(mime_type);
        }
    }
}

const MAX_SNAPSHOT: usize = 16 * 1024 * 1024;
const MAX_FORMATS: usize = 32;

/// Snapshot every advertised representation, or leave the clipboard alone.
/// Binary formats are never decoded as text. No clipboard content is logged.
fn snapshot(
    conn: &Connection,
    queue: &mut EventQueue<State>,
    state: &mut State,
) -> Result<Vec<Offer>> {
    let Some(offer) = state.selection.clone() else {
        return Ok(Vec::new());
    };
    let generation = state.generation;
    let types = state.types.get(&offer.id()).cloned().unwrap_or_default();
    if types.is_empty() || types.len() > MAX_FORMATS {
        return Err("clipboard formats cannot be preserved safely".into());
    }
    let deadline = Instant::now() + Duration::from_millis(800);
    let mut saved = Vec::new();
    let mut total = 0;
    for mime in types {
        let (mut reader, writer) = UnixStream::pair().map_err(|e| e.to_string())?;
        reader.set_nonblocking(true).map_err(|e| e.to_string())?;
        offer.receive(mime.clone(), writer.as_fd());
        drop(writer);
        conn.flush().map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        loop {
            if Instant::now() >= deadline {
                return Err("clipboard snapshot timed out; unchanged".into());
            }
            let mut buf = [0u8; 8192];
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if total > MAX_SNAPSHOT {
                        return Err("clipboard exceeds preservation limit; unchanged".into());
                    }
                    bytes.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => pump(conn, queue, state)?,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err("clipboard snapshot failed; unchanged".into()),
            }
            if state.generation != generation {
                return Err("clipboard changed during snapshot; paste cancelled".into());
            }
        }
        saved.push((mime, bytes));
    }
    queue.roundtrip(state).map_err(|e| e.to_string())?;
    if state.generation != generation {
        return Err("clipboard changed during snapshot; paste cancelled".into());
    }
    Ok(saved)
}

fn pump(conn: &Connection, queue: &mut EventQueue<State>, state: &mut State) -> Result<()> {
    queue.dispatch_pending(state).map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    if let Some(guard) = queue.prepare_read() {
        let mut fd = libc::pollfd {
            fd: conn.as_fd().as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut fd, 1, 10) };
        if result > 0 {
            guard.read().map_err(|e| e.to_string())?;
        }
    }
    queue.dispatch_pending(state).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_bounded(mut file: File, bytes: &[u8]) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut offset = 0;
    while offset < bytes.len() {
        if Instant::now() >= deadline {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        match file.write(&bytes[offset..]) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => offset += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

impl Dispatch<WlSeat, ()> for State {
    fn event(
        _: &mut Self,
        _: &WlSeat,
        _: wayland_client::protocol::wl_seat::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(offers: Vec<Offer>) {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let conn = Connection::connect_to_env().unwrap();
            let (globals, mut queue) = registry_queue_init::<State>(&conn).unwrap();
            let qh = queue.handle();
            let manager: ExtDataControlManagerV1 = globals.bind(&qh, 1..=1, ()).unwrap();
            let seat: WlSeat = globals.bind(&qh, 1..=9, ()).unwrap();
            let device = manager.get_data_device(&seat, &qh, ());
            let source = manager.create_data_source(&qh, Arc::new(offers.clone()));
            let mut state = State {
                offers,
                cancelled: false,
                active_source: Some(source.id()),
                selection: None,
                types: HashMap::new(),
                generation: 0,
                owned: Arc::new(AtomicBool::new(true)),
                writers: Arc::new(AtomicUsize::new(0)),
            };
            for (mime, _) in &state.offers {
                source.offer(mime.clone());
            }
            device.set_selection(if state.offers.is_empty() {
                None
            } else {
                Some(&source)
            });
            queue.roundtrip(&mut state).unwrap();
            tx.send(()).unwrap();
            while !state.cancelled && !state.offers.is_empty() {
                if queue.blocking_dispatch(&mut state).is_err() {
                    break;
                }
            }
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    fn read(mime: &str) -> Vec<u8> {
        let output = std::process::Command::new("wl-paste")
            .args(["--no-newline", "--type", mime])
            .output()
            .unwrap();
        assert!(output.status.success());
        output.stdout
    }

    #[test]
    fn bounded_writer_preserves_binary_bytes() {
        let (mut reader, writer) = UnixStream::pair().unwrap();
        let bytes = vec![0, 255, 10, 13, 128];
        let expected = bytes.clone();
        let thread = std::thread::spawn(move || {
            write_bounded(File::from(std::os::fd::OwnedFd::from(writer)), &bytes)
        });
        let mut result = Vec::new();
        reader.read_to_end(&mut result).unwrap();
        thread.join().unwrap().unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn bounded_writer_times_out_when_consumer_stalls() {
        let (_reader, writer) = UnixStream::pair().unwrap();
        let start = Instant::now();
        assert_eq!(
            write_bounded(
                File::from(std::os::fd::OwnedFd::from(writer)),
                &vec![1; 4 * 1024 * 1024]
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    #[ignore = "requires a disposable compositor: mutates only its test clipboard"]
    fn isolated_clipboard_transactions() {
        let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap();
        assert!(
            runtime.starts_with("/home/ddm/.cache/wispr-flow/clipboard-test."),
            "refusing to touch the real desktop clipboard"
        );
        let old = vec![
            ("text/plain;charset=utf-8".into(), b"prior text\n".to_vec()),
            ("text/html".into(), b"<b>prior text</b>".to_vec()),
            ("image/png".into(), vec![137, 80, 78, 71, 0, 255, 128, 10]),
        ];
        let paste = vec![("text/plain;charset=utf-8".into(), b"dictation".to_vec())];
        fixture(old.clone());
        with_clipboard(paste.clone(), |_| {
            assert_eq!(read("text/plain;charset=utf-8"), b"dictation");
            Ok(())
        })
        .unwrap();
        for (mime, bytes) in &old {
            assert_eq!(read(mime), *bytes);
        }

        // No keyboard input on a failed focus check; still restore the clipboard.
        assert!(with_clipboard(paste.clone(), |_| Err("focus changed".into())).is_err());
        for (mime, bytes) in &old {
            assert_eq!(read(mime), *bytes);
        }

        // Ownership, not payload comparison: a new copy of identical dictation
        // bytes must win over our saved clipboard.
        with_clipboard(paste.clone(), |_| {
            fixture(paste.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(read("text/plain;charset=utf-8"), b"dictation");

        fixture(Vec::new());
        with_clipboard(paste.clone(), |_| Ok(())).unwrap();
        let output = std::process::Command::new("wl-paste")
            .arg("--list-types")
            .output()
            .unwrap();
        assert!(!output.status.success() || output.stdout.is_empty());

        // Oversized snapshots must fail before clipboard mutation or injection.
        fixture(vec![(
            "application/octet-stream".into(),
            vec![7; MAX_SNAPSHOT + 1],
        )]);
        assert!(
            with_clipboard(paste, |_| panic!("must not paste after snapshot failure")).is_err()
        );
        assert_eq!(read("application/octet-stream").len(), MAX_SNAPSHOT + 1);
        fixture(Vec::new());
    }
}

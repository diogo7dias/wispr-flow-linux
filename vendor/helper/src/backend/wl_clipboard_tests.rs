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

#[test]
fn pseudo_targets_are_not_snapshotted() {
    for mime in ["SAVE_TARGETS", "COMPOUND_TEXT", "TARGETS", "MULTIPLE", "TIMESTAMP"] {
        assert!(is_pseudo_target(mime), "{mime}");
    }
    for mime in ["text/plain", "UTF8_STRING", "STRING", "TEXT", "image/png"] {
        assert!(!is_pseudo_target(mime), "{mime}");
    }
}

# Clipboard safety

The vendored Wayland helper preserves clipboard formats around dictation and
avoids synthetic copy shortcuts when reading selected text.

- Snapshot every offered MIME representation as bytes (including HTML and
  images), in memory only. No clipboard contents are added to logs.
- Refuse paste before mutation if a snapshot fails, changes during capture,
  exceeds 32 formats / 16 MiB total, or exceeds the 800 ms data-read budget.
- Offer dictation only after snapshot success. Hyprland focus is checked before
  preparation and again just before the paste chord, comparing address, PID,
  and class. Unknown focus fails closed. Terminal paste remains Ctrl+Shift+V.
- Restore after a 750 ms grace period, unless the compositor reports a new
  clipboard owner. Ownership, not matching text, decides whether to restore.
- Serve restored formats until the next copy. This is an in-memory clipboard
  owner, not persistent storage: quitting/crashing the helper can lose its
  owned selection unless a desktop clipboard manager has saved it.
- Never fall back to a plain-text-only overwrite if ext-data-control is absent.
- Selection reads use AT-SPI only; unavailable selection returns empty context
  rather than sending Ctrl+C or treating stale clipboard content as selection.

## Limits

The grace period is a timing compromise, not proof that an application consumed
the paste. Very slow applications may need a longer delay. Helper ACK follows
restoration; text injection itself does not wait for that grace period.

Focus checking and clipboard restoration are not atomic compositor operations.
A narrow race remains between the final check and the input/selection request.
Checks concern top-level windows, not individual text fields or the window that
was focused when recording started. Other compositors do not have the Hyprland
identity guard. X11 behavior is unchanged.

This follows the [ext-data-control protocol](https://wayland.app/protocols/ext-data-control-v1)
ownership notifications; it cannot provide a compare-and-set operation that
the protocol does not expose.

## Validation

`cargo test --locked --manifest-path vendor/helper/Cargo.toml` tests window
identity parsing and bounded binary writes, alongside the existing helper tests.

The ignored `isolated_clipboard_transactions` test runs only on a disposable
compositor with a guarded runtime path. It covers multi-format binary/text/HTML
restoration, failed paste callbacks, replacement by a new owner carrying the
same text, restoring an empty clipboard, and refusing an oversized snapshot
without invoking paste. It never synthesizes keyboard events.

On 2026-09-12 it passed on a separate nested Hyprland instance using runtime
`/home/ddm/.cache/wispr-flow/clipboard-test.QSwK3V`; the user's clipboard was
not used for those tests. Live dictation still requires a user smoke test.
All 12 ordinary helper tests and the isolated transaction test passed, along
with strict `cargo clippy --all-targets -- -D warnings` and formatting checks
for the changed Rust files.

Rollback binary on this machine:
`/home/ddm/.cache/wispr-flow/pre-clipboard-safety.ntgWFD/wispr-flow-linux-helper`.
Restore it only while Flow is stopped, or atomically rename a copied binary
over the installed helper and restart Flow. The app archive was not changed.

Quick user test: copy some ordinary text, dictate into an empty editor, then
manually paste. The manual paste should insert the original copied text.

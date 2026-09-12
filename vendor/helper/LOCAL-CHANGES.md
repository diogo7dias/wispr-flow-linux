# Local helper provenance

Source: https://github.com/wispr-flow-linux/helper
Revision: fa93fcf31d9ee7a9591a8dce1852f815d1b0dec5.

Local changes in `src/backend/wayland.rs` detect terminal classes through
Hyprland, use Ctrl+Shift+V for terminal paste, and avoid Ctrl+C selection probes
inside terminals. All other source is preserved from the local audited checkout.
This is clean-room helper source, not proprietary Flow code.

Build with `cargo build --release --locked`. The parent build uses this source
by default. An explicit HELPER_BIN override bypasses it and is the caller's
responsibility.

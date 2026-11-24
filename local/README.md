# Personal installation persistence

See [keyboard reliability and private diagnostics](keyboard-and-diagnostics.md)
for hot-plug, the local shortcut-only mode, trade-offs, tests, and rollback.

See [shared input permissions](input-permissions.md) for the narrower local
device-access policy, fresh-login requirement, validation, and rollback.

The fork applies and verifies the sandbox, audio-refresh, status-broadcast,
70-percent status-size and voice-level-range patches on every build. The last
one maps the pill's microphone level onto a fixed -55 to -5 dBFS range: the
stock scaler saturates 20 dB above the quietest sample it has seen, so the
level sat near 1.0 and the pill's waveform looped at a fixed size whatever
was said. Since the 1.6.1337 sync, hidden
startup (`--hidden`) and the compact status window come from upstream's
`linux-autostart` and `linux-status-compact`; the local start-hidden,
status-window-size, status-input-region and status-animation patches no longer
anchored and were removed. It builds `vendor/helper`
with Cargo.lock, preserving terminal paste and safe terminal selection behavior.
The helper also includes [clipboard preservation and focus guards](clipboard-safety.md).
`HELPER_BIN` explicitly overrides that helper; do not set it for normal builds.

The shared launcher enables sandboxing and the tested graphics/scaling flags.
Build using the existing `./build.sh --build appimage` workflow. New upstream
bundle layouts may require patch maintenance; unsupported layouts fail loudly.
Automatic compatibility with arbitrary future Flow releases is not guaranteed.

The installed application on this machine lives at
`~/.local/share/wispr-flow/AppDir`, independently of `build-linux/`.
The desktop launcher and bar use `~/.local/bin/wispr-flow`.
Builds do not automatically replace the running installation. Use the
[safe local updater](safe-updates.md) to validate, stage, test startup, and keep
the previous installation for rollback. Do not let the proprietary updater
replace this custom build; update the pinned version through this fork instead.

`omarchy/ddm.wispr-flow/` preserves the custom bar button. Its installed copy is
in `~/.config/omarchy/plugins/ddm.wispr-flow/`; shell.json places it immediately
after `omarchy.workspaces` in the left group. These user settings survive app
rebuilds and are intentionally not overwritten by the build.

The existing user Hyprland rule targets initial title `Flow Status Indicator`:
floating, pinned, bottom-center, no border/blur/shadow/dimming/animation, opacity
1. It remains in `~/.config/hypr/hyprland.lua` independently of application builds.

The bottom-docked Linux status window is 200 by 110 logical pixels on Flow
1.6.1337 (upstream's compact size). Click-through around the pill on Hyprland
is not verified for this size.

Validation: `node --test tests/*.test.cjs`, `bats tests/*.bats`, and
`cargo test --locked --manifest-path vendor/helper/Cargo.toml`.
See [audio device refresh](audio-refresh.md) for microphone-event serialization,
wake-gap refresh behavior, tests, and limitations.
See [clean rebuild validation](rebuild-validation.md) for the tested inputs,
results, and remaining runtime/package-format limits.
Only clean-room source, patch tools, and tests belong in Git; no extracted
proprietary application or account data is committed.

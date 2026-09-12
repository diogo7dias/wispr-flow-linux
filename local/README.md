# Personal installation persistence

The fork applies and verifies the sandbox, hidden-startup, animation-cadence,
and 70-percent status-size patches on every build. It builds `vendor/helper`
with Cargo.lock, preserving terminal paste and safe terminal selection behavior.
`HELPER_BIN` explicitly overrides that helper; do not set it for normal builds.

The shared launcher enables sandboxing and the tested graphics/scaling flags.
Build using the existing `./build.sh --build appimage` workflow. New upstream
bundle layouts may require patch maintenance; unsupported layouts fail loudly.
Automatic compatibility with arbitrary future Flow releases is not guaranteed.

The installed application on this machine lives at
`~/.local/share/wispr-flow/AppDir`, independently of `build-linux/`.
The desktop launcher and bar use `~/.local/bin/wispr-flow`.
Builds do not automatically replace the running installation. Test a new AppDir
before deployment, quit Flow, back up the installed AppDir, then replace it.
Keep the previous installation for rollback. Do not let the proprietary updater
replace this custom build; update the pinned version through this fork instead.

`omarchy/ddm.wispr-flow/` preserves the custom bar button. Its installed copy is
in `~/.config/omarchy/plugins/ddm.wispr-flow/`; shell.json places it immediately
after `omarchy.workspaces` in the left group. These user settings survive app
rebuilds and are intentionally not overwritten by the build.

The existing user Hyprland rule targets initial title `Flow Status Indicator`:
floating, pinned, bottom-center, no border/blur/shadow/dimming/animation, opacity
1. It remains in `~/.config/hypr/hyprland.lua` independently of application builds.

Validation: `node --test tests/*.test.cjs`, `bats tests/*.bats`, and
`cargo test --locked --manifest-path vendor/helper/Cargo.toml`.
Only clean-room source, patch tools, and tests belong in Git; no extracted
proprietary application or account data is committed.

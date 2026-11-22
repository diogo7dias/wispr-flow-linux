# Keyboard reliability and private diagnostics

Flow now supports keyboard hot-plug, privacy-filtered diagnostics, and an
opt-in Hyprland shortcut-only capture backend enabled in this local launcher.

```bash
wispr-flow-diagnostics
# After fully quitting Flow, explicit fallback for one launch:
WISPR_SHORTCUT_ONLY=0 wispr-flow
```

## Keyboard hot-plug

The evdev fallback scans for keyboards every two seconds, including when none
were readable at startup. Readers are keyed by device number and inode, so a
reused event path can acquire a new reader after unplug. Finished readers are
removed; the supervisor caps concurrent readers at 64. Unplugged held keys
continue to be cleared by the application's existing stale-key checks.
Flow's own virtual keyboard is excluded to avoid capturing injected paste as
shortcut input. Native X11 capture continues to use XInput2.

A live test created a keyboard after capture started, verified its descriptor
was acquired, destroyed it and verified release, then repeated for reconnect.
It injected no keys. A physical USB/Bluetooth reconnect remains a user test.
In shortcut-only mode Hyprland handles physical keyboard discovery instead.

## Shortcut-only mode

`WISPR_SHORTCUT_ONLY=1` registers `wispr-flow:dictate` and `wispr-flow:cancel`
through the Hyprland global-shortcuts Wayland protocol. Only those actions
become helper key events: Left Alt (VK 164) and Escape (VK 27). The backend
tracks their pressed state for stale-key queries, ignores duplicate edges,
and emits releases on compositor disconnect. It does not silently fall back
to raw input when registration fails. Restart Flow after a lost compositor
connection; automatic reconnect is not implemented in this backend.

The local launcher enables it; the reproducible binding source is
`local/wispr-shortcuts.lua`, installed at `~/.config/hypr/wispr-shortcuts.lua`
and required by `bindings.lua`. Other machines must install their bindings
before enabling this opt-in backend. Builds alone do not enable it globally.
The binding uses the
[documented global dispatcher](https://wiki.hypr.land/configuring/core/binds/globals/).

Live testing found that this Hyprland version needs `ignore_mods=true` for
both edges of a lone Alt binding to arrive. Consequently Alt may also trigger
Flow while another modifier is held. The bind is non-consuming, so existing
applications still receive their keys. Escape remains non-consuming too.
Using a non-modifier dictation key is an alternative if Alt combinations clash.
No bindings run on the lock screen.

This mode does not support recording arbitrary shortcuts in Flow's settings.
Changing the dictation key requires updating the compositor binding; the
helper's synthesized key must continue to match Flow's configured shortcut.
It also skips the raw-device modifier snapshot during paste: release modifiers
before pasting, since this mode cannot neutralize unrelated held keys.

This is data minimization, not an OS sandbox. Flow's helper no longer opens raw
event devices in this mode, but same-user permissions retained for Omaclack and
Voxtype remain. The Electron application is not newly isolated from those
permissions. uinput access is still required for paste.

## Private diagnostics

`wispr-flow-diagnostics` emits allowlisted JSON statuses: session type, app and
helper presence, count of raw-input descriptors held by the installed helper,
uinput openability, expected shortcut registrations, microphone count/mute
summary, inherited input-group membership, and Linux patch presence.
It reads neither app logs nor account files, clipboard contents, transcripts,
or device events. Command output is parsed, never dumped. No upload occurs.
It does not prove that live microphone recording or pasting works.

## Deployment and rollback

The candidate passed the checked updater's isolated startup test. The old
AppDir is retained at `~/.local/share/wispr-flow/.update-I8oIAN/previous`.
Launcher and binding backups are under
`~/.cache/wispr-flow/shortcut-rollout-BpSAzY/`.

For a full binary rollback, quit Flow and run:

```bash
wispr-flow-update rollback .update-I8oIAN
WISPR_SHORTCUT_ONLY=0 wispr-flow
```

The old helper ignores the new environment variable; the explicit zero is also
the supported fallback on the new helper. To persist raw mode, change the local
launcher's default to zero and comment out `require("hypr.wispr-shortcuts")`
in bindings.lua, then reload and check `hyprctl configerrors`. Do not restore an
entire old bindings file over later unrelated changes.

Validation includes Rust formatting, Clippy with warnings denied, 16 Rust unit
tests, 35 Node tests, and live hot-plug and compositor press/release tests.
The clipboard integration test was not rerun in this change. Real dictation
after deployment still needs user confirmation.

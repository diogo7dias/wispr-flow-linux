# ddm.wispr -- Flow's dictation state in the Omarchy bar

The surviving indicator for Wispr Flow's dictation. The app's own bottom-centre
status pill is parked on the hidden `special:wispr-hidden` workspace instead of
being shown, so this widget is the only place dictation state appears.

## Where it sits

`shell.json` bar layout, centre group, immediately after `omarchy.weather`:

    ... "omarchy.weather", { "id": "ddm.wispr" }, "omarchy.system-update" ...

Icons keep the bar's own metrics (`Style.bar.statusSlot`, `Style.bar.iconFont`)
so it reads as a neighbour of the weather, keyboard-layout and system-update
glyphs rather than a guest.

## What it draws

| Flow state              | Drawing                                            |
| ----------------------- | -------------------------------------------------- |
| idle                    | a hairline, 12 of the 16 logical px, 0.55 opacity  |
| listening               | five columns driven by the app's live level        |
| transcribing            | the same five columns running a travelling wave    |
| error                   | hairline or bars in `Color.urgent`                 |
| click                   | a check glyph for 900 ms, then back to the haircut |

Left click copies the last transcription to the clipboard with `wl-copy` and
trims the boundary space the helper needs when pasting. The tooltip carries the
first 60 characters, so a failed paste is visible without clicking.
`pasted` (see below) tints the widget when the helper reports a failed paste.

## State contract

The widget polls `$XDG_RUNTIME_DIR/wispr-flow/status.json` (mode 0600) every
400 ms when idle and every 60 ms while Flow is working. The file is produced by
`scripts/patches/status-broadcast.cjs`, which is prepended to the app's main
bundle -- it observes the app's own `status:dictationStatus` and
`status:audioLevel` IPC and the helper's stdio pair. Nothing is written on the
app's behalf.

    {"state":"idle|listening|transcribing|error","level":0.0,"text":"",
     "pasted":null,"ts":1730000000000}

`pasted` stays null with the shipped helper: it emits no `PasteOutcome` (grep
the binary for the string and nothing comes back), so the failure tint only
appears when the app itself reports `error`. Click-to-copy does not depend on it.

## Installing changes

    cp -a local/omarchy/ddm.wispr ~/.config/omarchy/plugins/ddm.wispr
    omarchy-restart-shell

A restart is required: quickshell logs `Local plugin changed, reloading` when the
plugin directory changes, but the bar keeps the running widget instance, so a
hot edit only takes effect after `omarchy-restart-shell`.

## Rebuilding the app side

The state bridge lives inside `app.asar`. To reinstall it after changing the
runtime payload:

    node scripts/apply-local-fixes.cjs <extracted-app>
    node local/repack-asar.cjs <installed-app.asar> .webpack/main/index.js \
        <extracted-app>/.webpack/main/index.js <out-app.asar>
    node local/diff-asar.cjs <installed-app.asar> <out-app.asar>
    node scripts/safe-update.cjs check  <candidate>/AppDir
    node scripts/safe-update.cjs install <candidate>/AppDir

`repack-asar.cjs` rewrites one entry and keeps every other byte, including the
`unpacked` flags whose payloads live in `app.asar.unpacked`.
`diff-asar.cjs` proves only the intended entry changed before you install.
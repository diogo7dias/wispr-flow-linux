# Safe local updates

The local updater stages a trusted AppDir, validates it, and restores the old
installation automatically if its isolated startup check fails.

```bash
node scripts/safe-update.cjs check /absolute/path/to/new/AppDir
# Quit Flow completely, not just its dashboard, before installing.
node scripts/safe-update.cjs install /absolute/path/to/new/AppDir
# Restore a retained backup using the ID printed at installation:
node scripts/safe-update.cjs rollback .update-ABC123
# Recover a transaction interrupted by a killed updater:
node scripts/safe-update.cjs recover
```

The target is fixed to `~/.local/share/wispr-flow/AppDir`. The candidate must
live outside that installation tree. Existing launcher and desktop settings
are untouched. Node, bash, flock, xvfb-run and dbus-run-session are required.
Missing startup-test tools fail closed, never count as a successful test.

Validation checks all Linux patch markers, ASAR entry bounds and unpacked
files, syntax of main/hub/status JavaScript and launcher scripts, Linux ELF
magic for Electron/helper/SQLite, and absence of symlinks and setuid/setgid.
A SHA-256 tree comparison confirms staging copied the validated bytes.
This does not authenticate a download or replace a source/security audit.
Only use candidates built from trusted inputs through this fork's pipeline.

Installation requires Flow to be stopped, stages on the same filesystem,
holds a kernel file lock, and records recovery information before renaming.
The startup probe uses a private X display, D-Bus session and fresh profile,
requires helper-ready plus three seconds of survival, and has a 45-second
deadline. Failed candidates and private diagnostics are retained, not deleted.
Successful installations retain the old AppDir for manual rollback.

The probe never opens the real account profile. Consequently it cannot verify
account migrations, real Wayland paste, microphone input, or failures that
occur later. Rollback restores application files only, NOT account databases.
After a successful update, test real dictation before relying on the new build.
Do not start Flow from the bar while an update is in progress.

The journal handles process interruption; it is not a power-loss durability
guarantee. If recovery itself fails, files and journal remain for inspection.
Backups are not automatically pruned and consume disk space. The updater does
not download releases or replace the upstream update mechanism.

Implementation learning: archive-only backups are insufficient because ASAR
native modules live beside the archive. Preserve the entire AppDir. A fresh
profile is also essential: booting an unverified version against the real
database can perform migrations that replacing executables cannot undo.

## Local validation (2026-09-13)

Installed `xorg-server-xvfb` through `omarchy pkg add`. The real installed
Flow build passed a startup transaction on a separate copied installation,
using the private X display and profile. A second candidate with its executable
replaced by `/usr/bin/false` passed structural checks but failed real startup;
the updater restored the previous AppDir byte-for-byte automatically.
The working installation and logged-in account were not replaced or restarted.
Ten updater unit tests pass, including server-error classification and
interrupted-rename recovery. The test artifacts remain under
`~/.cache/wispr-flow/update-live-test-FxmV64` for inspection.

Live testing exposed two details now handled: HTML server responses may log a
JSON `SyntaxError` without breaking startup, and process termination/reaping
must finish before checking that the installation is stopped.

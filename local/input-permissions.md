# Shared input-device permissions

The local udev override limits extra active-seat access to keyboards, mice,
touchpads, and uinput while removing ddm's blanket input-group membership.

- Installed override: `/etc/udev/rules.d/70-wispr-flow-uinput.rules`.
- Source: `local/70-wispr-flow-uinput.rules`.
- Backup: `~/.cache/wispr-flow/input-permissions-backup-UpyH0K/`.
- Applied and checked: 2026-09-13.

The override has the same basename as the packaged rule, so `/etc` takes
precedence across application rebuilds and package updates. It does not alter
the stock systemd rules or the Omarchy source. Stock permissions for other
device classes, such as game controllers, remain independent of this override.

Omaclack uses keyboard and mouse events, not only keyboard events. Therefore
mouse/touchpad access must remain alongside the keyboard access used by Flow
and Voxtype. The virtual keyboard used for paste remains available via uinput.

Validation used a new process with ddm's updated supplementary groups, without
reading or recording input events. It could open 7 of the 26 current event
devices: event3, event8, event9, event12, event21, event22, event23. The other
19 were denied. All keyboard nodes already open by Flow and Voxtype remained
accessible, as did Omaclack's keyboard/mouse/touchpad devices. Opening uinput
for writing succeeded without creating a virtual device or injecting keys.
The udev syntax check and three policy regression tests passed.

Removing the broad rule did not remove its existing named ACLs automatically.
The stale ddm ACL entries were explicitly removed only from nodes whose current
udev tags no longer included uaccess. ACLs on retained devices were preserved.

## Complete the transition

Save work and fully log out and back in (or reboot). Existing processes retain
their supplementary groups and open file descriptors; launching a new terminal
inside the old desktop session does not reliably drop that inherited access.
No desktop restart or logout was performed automatically.

After login, check `id` (no input group), dictate with Flow, test Voxtype's
shortcut, and check Omaclack keyboard and mouse sounds. End-to-end testing of
those actions after a fresh login still requires the user.

This is narrower shared user access, NOT per-application isolation. Other
programs running as the active user can still open the permitted keyboards.
uaccess grants read/write, not read-only, and removing an ACL does not revoke
an already-open device descriptor. Preventing access to ordinary keystrokes
requires a separate shortcut broker/compositor integration, not just this rule.

## Rollback

Restore only this policy and group membership; do not overwrite `/etc/group`
with the reference copy in the backup directory.

```bash
sudo install -o root -g root -m 0644 \
  /home/ddm/.cache/wispr-flow/input-permissions-backup-UpyH0K/70-wispr-flow-uinput.rules \
  /etc/udev/rules.d/70-wispr-flow-uinput.rules
sudo gpasswd -a ddm input
sudo udevadm control --reload-rules
sudo udevadm trigger --action=change --subsystem-match=input
sudo udevadm trigger --action=change --subsystem-match=misc --sysname-match=uinput
sudo udevadm settle
```

This restores the old broad policy. Log in again if applications need the
restored group membership. The backup contains the original rule and a reference
copy of the group listing, not credentials or captured keystrokes.

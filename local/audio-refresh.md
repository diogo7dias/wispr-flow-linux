# Audio device refresh

Linux microphone-change notifications are debounced and serialized, with a
device-list refresh after a long renderer timer gap.

- Events settling within 300 ms produce one refresh.
- Events arriving during a refresh produce one queued follow-up, not concurrent
  device selection updates.
- A five-second timer notices gaps over fifteen seconds (or a backwards clock
  change), then schedules the same refresh. This is a wake/stall heuristic,
  not a direct suspend notification. Background throttling can also trigger it.
- The patch calls Flow's existing `handleDeviceChange`: selection, unplug
  notifications, and stopping dictation when its selected mic disappears remain
  upstream behavior. It does not promise uninterrupted capture across unplug.
- No app/helper restart, automatic recording start, audio graph replacement,
  new IPC channel, or microphone permission is introduced by this patch.
- Repeated media initialization does not accumulate listeners or timers.
- Refresh failures are caught and logged without device identifiers. A later
  event can retry; there is no unbounded automatic retry loop.

This improves refresh scheduling, not every possible sleep/audio-server failure.
Flow already has audio graph repair and acquisition retry paths; those are left
unchanged. A hanging upstream enumeration is not cancelled or bypassed.

`scripts/patches/audio-refresh.cjs` injects the clean-room runtime into the hub
renderer. The normal local-fix pipeline and archive marker gate include it.
Unknown bundle anchors fail before writing. Eight tests cover burst coalescing,
in-flight serialization, wake-gap behavior, failure containment, cleanup,
Linux-only/idempotent installation, browser timer receiver semantics, and
missing/ambiguous patch anchors. Browser timers must be called unbound, not as
methods of the injected adapter: Chromium rejects that receiver with an
`Illegal invocation` error even when Node mocks accept it.

Validation on 2026-09-13: 20 Node tests and 87 Bats tests passed. The staged
archive changes only `.webpack/renderer/hub/index.js`; native modules and all
other archived files were compared against the installed archive. Real suspend,
microphone unplug/reconnect, and dictation after waking require a live test.
After deployment, the running app logged `Linux audio refresh ready` and the
helper-ready message, with no media initialization or refresh failure in the
new startup log segment.

Deployment backup:
`/home/ddm/.cache/wispr-flow/audio-refresh.BfhWeh/app.asar.before`.
To roll back, quit Flow, restore that archive to the installed resources
directory, then launch Flow again. The Rust clipboard helper is unchanged.

## Audio server restarts (2026-11-23)

The patch above handles device changes. It does not help when the audio server
itself restarts, which this machine does after every resume
(`audio-restart-after-resume.service`): Flow's Chromium audio process keeps its
dead PulseAudio connection and dictation fails with `MicNotFound`.
`pipewire-pulse-wispr-audio.conf` is a drop-in for the user unit
`pipewire-pulse.service` that ends that one subprocess whenever the audio server
starts; Flow starts a fresh one on the next dictation. Install it as
`~/.config/systemd/user/pipewire-pulse.service.d/wispr-audio.conf`, then run
`systemctl --user daemon-reload`. To roll back, delete that file and reload.
Validated by restarting `pipewire-pulse.service` with Flow running: the audio
subprocess was replaced and the next dictation opened the microphone. A real
suspend and resume was not tested.

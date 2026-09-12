# Local sandbox and status cadence experiment

Flow 1.6.827 can initialize its preloads with forced Electron sandboxing after removing Node-only diagnostic dependencies.

- `scripts/patches/sandbox-preloads.cjs` patches all eight identical preloads.
  The Node filesystem import only supplies optional WDIO diagnostic file logging;
  that capability now explicitly rejects use. Diagnostic formatting is simplified
  and output goes to the renderer console. No new privileged IPC is introduced.
- Run with `--disable-setuid-sandbox --enable-sandbox`, without `--no-sandbox`.
  This requires working unprivileged user namespaces. Never make an executable
  in a user-writable installation setuid-root.
- Runtime validation on Omarchy: four loaded renderer processes have seccomp
  filtering, no-new-privileges, and a separate user namespace; application and
  store bridges initialize, and user-confirmed dictation reaches the terminal.
- Main process and native helper remain privileged. Existing IPC authorization
  has not been comprehensively audited. This is not whole-app confinement.
- `scripts/patches/status-animation.cjs` removes the status ticker's fixed 50 ms
  throttle. Its waveform and audio smoothing consumers use elapsed time. The
  existing hidden/unsubscribed guards remain. Active animation CPU usage may rise.
- A 240-frame idle status sample averaged 8.33 ms, p95 8.4 ms, max 8.5 ms.
  This measures frame callbacks, not presentation or dictation-animation FPS.
- Two observed stop-recording-to-PasteText-request intervals were 471 ms and
  314 ms. They are small-sample app-log timings, not end-to-end paste confirmation
  or isolated server latency. No dictated text was included in the measurements.

The fork now applies these patches through `scripts/apply-local-fixes.cjs`
before repacking and verifies their markers in the shipped archive. Startup
hiding and 70-percent status sizing are included. Revalidate on version changes;
changed anchors fail the build instead of silently dropping a patch.

Run `node --test tests/sandbox-preloads.test.cjs tests/status-animation.test.cjs`.

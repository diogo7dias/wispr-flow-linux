# Clean rebuild validation — 2026-09-12

A fresh build reproduced the customized application without replacing or
restarting the installed copy.

## Inputs and isolation

- Source: local clone of commit `ea62c246a7cdad0b8fa8c07ef92fbd49c863f285`.
- Scratch directory: `/home/ddm/.cache/wispr-flow/clean-build.60aW2w/repo`.
- Command: `./build.sh --build appimage`.
- No existing extract, patched bundle, native-module directory, or helper build
  output was copied into the clone. Normal npm/Cargo download caches remained
  available.
- Flow 1.6.827 was downloaded again from the official installer endpoint.
  SHA-256 verified against its manifest:
  `9eba11fe13dcc6ee11bd199e469eceb9ba294bb799441eaa2f884c8867a3f905`.
- Electron 42.3.0 was downloaded and checksum-verified. Native SQLite binaries
  were fetched with the existing checksum/provenance checks. The vendored Rust
  helper was compiled from source with `--locked`.

## Results

- Clean extraction, all patches, asar repacking, and AppDir staging succeeded.
- All 15 shipped patch markers were present.
- Main JavaScript, status JavaScript/HTML, all eight renderer preloads, Electron
  executable, and Rust helper were byte-identical to the working installation.
- Shared launcher differed only in comments; executable code was unchanged.
- Artifact inspector reported 30 passes, including one explicit skipped GUI
  launch test (29 checks and one skip); no failures.
- Native smoke test passed under the freshly downloaded Electron: ABI 146,
  SQLite module loading, encrypted write/read, and wrong-key rejection.
- Unit tests: 12 JavaScript, 87 Bats, and 9 Rust tests passed (108 total).
  The three voice-animation experimental tests are still present but those
  patches are not enabled by `apply-local-fixes.cjs`.

## Regression coverage added during validation

The verifier's fixture lacked the six personal patch markers. Updated it and
required a passing full fixture before the omit-one matrix, so missing markers
cannot make all negative tests pass for the wrong reason.

Added compact-window tests for Linux 140x44 geometry, unchanged Windows/macOS
dimensions, dollar-sign identifiers, idempotency, migration of older compact
sizes, and refusal of missing/ambiguous/changed anchors without file mutation.
These test-only changes were run in the working repository after the clone.

## Limits

- `appimagetool` is absent, so the output is an AppDir, not a single-file
  `.AppImage`. This matches the current installation format.
- No full GUI launch or live dictation test of the candidate was performed.
  The working app and account profile were left untouched; byte comparison is
  not a replacement for a future post-deployment end-to-end test.
- Bar placement, pinned workspace behavior, and the borderless bottom-center
  rule remain user desktop configuration, outside the application build.
- This validates rebuilding the pinned version, not compatibility with unknown
  future upstream releases or a complete security audit.

Build log: `/home/ddm/.cache/wispr-flow/clean-build.60aW2w/build.log`.
Candidate: `repo/build-linux/appimage/ai.wisprflow.WisprFlow.AppDir` under the
scratch directory's parent. Nothing was deployed or pushed to GitHub.

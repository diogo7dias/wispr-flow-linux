#!/usr/bin/env bash
#===============================================================================
# patch-helper-env.sh
#
# Restores the session environment to the native-helper child process in the
# webpack-bundled Electron main process (.webpack/main/index.js).
#
# WHY THIS PATCH EXISTS
# ---------------------
# The shipped main bundle spawns the native helper with a REPLACEMENT env
# object that lists only telemetry keys -- it does NOT spread process.env:
#
#   helper.process = spawn(s, {
#     stdio:["pipe","pipe","pipe","pipe"],
#     env:{ sentryDSN, environment, segmentWriteKey,
#           postHogProjectKey, sentryLocalDebug } })
#
# On macOS/Windows the helper talks to the OS through native APIs and needs no
# session env, so upstream never spread process.env. But the Linux helper's
# backend detection (the helper's src/backend/mod.rs::pick_injector;
# github.com/wispr-flow-linux/helper) gates
# the Wayland/X11 injection + clipboard + active-app backends on the session
# env vars WAYLAND_DISPLAY / DISPLAY (and, to actually connect, XDG_RUNTIME_DIR
# and DBUS_SESSION_BUS_ADDRESS). With the replacement env none of those reach
# the child, so the helper falls through to the no-op `stub` backend:
#
#   WARN  ...backend] injection: stub (no-op) -- OS integration disabled
#
# The mic records and shortcuts fire (keypress capture reads /dev/input
# directly, needing no env), but PasteText returns
#   "PasteText failed: no backend available (stub)"
# and nothing is ever injected into the focused field. This was misdiagnosed in
# helper-resolver.sh PATCH NOTE #3 as "harmless"; it is the cause of the dead
# text injection. See docs/learnings/helper-spawn-env.md.
#
# THE PATCH (surgical, one insertion point)
# -----------------------------------------
# Anchor on stable helper-launch literals. Older Flow bundles inline the
# telemetry env object after the 4-pipe stdio array; current bundles factor the
# same object into a minified function such as `N=(e=a.app.isPackaged)=>({`.
# Insert the parent environment at the FRONT of that object so the session
# env propagates, while telemetry keys that follow still override collisions.
#
#   env:Object.assign({},process.env,{sentryDSN:...}) (marker carries the token)
#
# stdio / fd-3 / exec-bit notes live in helper-resolver.sh PATCH NOTES.
#===============================================================================
set -euo pipefail

BUNDLE="${1:-}"
if [[ -z "$BUNDLE" ]]; then
  # default to the in-repo extracted bundle
  BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/extract/app/.webpack/main/index.js"
fi

if [[ ! -f "$BUNDLE" ]]; then
  echo "ERROR: bundle not found: $BUNDLE" >&2
  exit 1
fi

# --- Idempotency guard --------------------------------------------------------
ENV_MARKER="WISPR_LINUX_HELPER_ENV"
if grep -q "$ENV_MARKER" "$BUNDLE"; then
  echo "Already patched ($ENV_MARKER present in $BUNDLE) - nothing to do."
  exit 0
fi

# --- Backup -------------------------------------------------------------------
if [[ ! -f "$BUNDLE.orig" ]]; then
  cp -p "$BUNDLE" "$BUNDLE.orig"
  echo "Backup written: $BUNDLE.orig"
fi

# --- Patch (anchored on stable string/property literals, no minified ids) -----
python3 - "$BUNDLE" "$ENV_MARKER" <<'PY'
import sys, io
path, marker = sys.argv[1], sys.argv[2]
with io.open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
    data = f.read()

# Older bundle: inline object following the four-pipe helper spawn.
anchors = [
    'stdio:["pipe","pipe","pipe","pipe"],env:{',
    '=>({sentryDSN:',
]
matches = []
for anchor in anchors:
    matches.extend((i, anchor) for i in range(len(data)) if data.startswith(anchor, i))
if len(matches) != 1:
    sys.exit(f"ERROR: expected exactly 1 helper-spawn env anchor, found {len(matches)}.")

pos, anchor = matches[0]
after = data[pos + len(anchor):]
if after.startswith("...process.env") or after.startswith(f"/*{marker}*/"):
    sys.exit(0)  # already spreads the parent env -- nothing to do

# Insert the marker comment + parent environment at the front of the env
# object. Object.assign avoids depending on the bundle's parser target for
# object spread while preserving the telemetry fields that follow.
if anchor == '=>({sentryDSN:':
    repl = '=>Object.assign({},process.env,{' + f"/*{marker}*/sentryDSN:"
else:
    repl = anchor + f"/*{marker}*/...process.env,"
data = data[:pos] + repl + data[pos + len(anchor):]

with io.open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
    f.write(data)
print("Patched: spread process.env into the helper-spawn env object (1).")
PY

# --- Verify the result --------------------------------------------------------
if ! grep -q "$ENV_MARKER" "$BUNDLE"; then
  echo "ERROR: post-patch verification failed (marker not found)." >&2
  echo "       Restoring backup." >&2
  cp -p "$BUNDLE.orig" "$BUNDLE"
  exit 1
fi

# Syntax-check: the spread is inside an object literal; catch any edit that
# serializes but doesn't parse before it ever reaches asar.
if command -v node >/dev/null; then
  if ! node --check "$BUNDLE"; then
    echo "ERROR: node --check failed on patched bundle. Restoring backup." >&2
    cp -p "$BUNDLE.orig" "$BUNDLE"
    exit 1
  fi
  echo "node --check OK"
fi
echo "OK: helper-spawn env now inherits the session environment in $BUNDLE"
echo
echo "Patched spawn now does (conceptually):"
echo "  spawn(helper, { stdio:[...x4],"
echo "    env:{ ...process.env, sentryDSN, environment, ... } });"

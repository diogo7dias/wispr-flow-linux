#!/usr/bin/env node
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = process.argv[2];
if (!root) throw new Error('Usage: apply-local-fixes.cjs <extracted-app>');
const patches = [
 ['audio-refresh.cjs', path.join(root, '.webpack/renderer/hub/index.js')],
 ['sandbox-preloads.cjs', root],
 ['start-hidden.cjs', path.join(root, '.webpack/main/index.js')],
 ['status-broadcast.cjs', path.join(root, '.webpack/main/index.js')],
 ['status-input-region.cjs', path.join(root, '.webpack/main/index.js')],
 ['status-window-size.cjs', path.join(root, '.webpack/main/index.js')],
 ['status-animation.cjs', path.join(root, '.webpack/renderer/status/index.js')],
 ['status-size.cjs', path.join(root, '.webpack/renderer/status/index.html')],
];
for (const [script, target] of patches) {
 const result = spawnSync(process.execPath,
  [path.join(__dirname, 'patches', script), target], {stdio:'inherit'});
 if (result.status !== 0) process.exit(1);
}

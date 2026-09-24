#!/usr/bin/env node
// Publish dictation state for the Omarchy bar widget. The payload observes
// Electron/Node surfaces only (see status-broadcast-runtime.js) and is
// prepended to the main bundle, where `require` is still Node's own.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = process.argv[2];
const marker = 'WISPR_LINUX_STATUS_BROADCAST';
let code = fs.readFileSync(file, 'utf8');
if (code.includes(marker)) process.exit(0);
// The payload is a statement and the bundle opens with webpack's IIFE, so
// prepending keeps both intact. Assert the layout before trusting it.
if (!/^(\/\*|!function\(\)\{)/.test(code)) {
  throw new Error('Unrecognised main bundle layout; re-audit required');
}
const payload = fs.readFileSync(path.join(__dirname, 'status-broadcast-runtime.js'), 'utf8');
const injected = `/*${marker}*/\n${payload}\n${code}`;
new vm.Script(injected, {filename: file});
fs.writeFileSync(file, injected);
console.log('Main bundle now publishes dictation state to $XDG_RUNTIME_DIR/wispr-flow.');
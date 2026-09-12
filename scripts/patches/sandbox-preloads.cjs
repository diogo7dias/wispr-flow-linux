#!/usr/bin/env node
// Local Linux experiment: remove Node-only diagnostic logging dependencies.
// Does not expose any new IPC or filesystem capability to renderers.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.argv[2];
if (!root) throw new Error('Usage: sandbox-preloads.cjs <extracted-app>');
const marker = 'WISPR_LINUX_SANDBOX_PRELOAD_V1';
const shim = `/*${marker}*/
const wisprSandboxDiagnostics = (() => {
 const inspect = value => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return '[unserializable diagnostic]'; }
 };
 return {
  fs: {createWriteStream() {
   throw new Error('File logging is unavailable in sandboxed preloads');
  }},
  util: {inspect, format: (...values) => values.map(inspect).join(' ')},
  os: {release: () => '0.0.0'},
  tty: {isatty: () => false},
  stdout: {isTTY: false, write: value => { console.log(value); return true; }},
  stderr: {fd: 2, write: value => { console.error(value); return true; }}
 };
})();
`;
const names = ['contextMenu', 'feature_tour', 'hub', 'meeting_ax_inspector',
 'meeting_recorder', 'overlay', 'scratchpad', 'status'];
const writes = [];
for (const name of names) {
 const file = path.join(root, '.webpack/renderer', name, 'preload.js');
 let code = fs.readFileSync(file, 'utf8');
 if (code.includes(marker)) continue;
 const modules = [...code.matchAll(/require\("([^"\n]+)"\)/g)].map(m => m[1]);
 if (modules.join(',') !== 'electron,fs,util,os,tty') {
  throw new Error(`${name}: dependency layout changed; re-audit required`);
 }
 for (const module of ['fs', 'util', 'os', 'tty']) {
  code = code.replace(`require("${module}")`, `wisprSandboxDiagnostics.${module}`);
 }
 code = code.replaceAll('process.stdout', 'wisprSandboxDiagnostics.stdout')
  .replaceAll('process.stderr', 'wisprSandboxDiagnostics.stderr');
 code = shim + code;
 new vm.Script(code, {filename: file});
 writes.push([file, code]);
}
// Validate every target before writing any of them.
for (const [file, code] of writes) fs.writeFileSync(file, code);
console.log(`Patched ${writes.length} preload files; no new privileged IPC.`);

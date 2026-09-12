const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/patches/sandbox-preloads.cjs');
const names = ['contextMenu', 'feature_tour', 'hub', 'meeting_ax_inspector',
 'meeting_recorder', 'overlay', 'scratchpad', 'status'];
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-sandbox-test-'));
 t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 const files = names.map(name => path.join(root, '.webpack/renderer', name, 'preload.js'));
 for (const file of files) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, 'require("electron");require("fs");require("util");require("os");require("tty");process.stdout;process.stderr;');
 }
 return {root, files};
}
test('patches all targets, removes Node imports, and is idempotent', t => {
 const {root, files} = fixture(t);
 assert.equal(spawnSync(process.execPath, [script, root]).status, 0);
 const patched = files.map(file => fs.readFileSync(file, 'utf8'));
 for (const code of patched) {
  assert.doesNotMatch(code, /require\("(?:fs|util|os|tty)"\)/);
  assert.doesNotMatch(code, /process\.(?:stdout|stderr)/);
  assert.match(code, /File logging is unavailable/);
 }
 assert.equal(spawnSync(process.execPath, [script, root]).status, 0);
 assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), patched);
});
test('unknown dependency fails before any file is changed', t => {
 const {root, files} = fixture(t);
 fs.appendFileSync(files.at(-1), 'require("child_process");');
 const before = files.map(file => fs.readFileSync(file, 'utf8'));
 assert.notEqual(spawnSync(process.execPath, [script, root]).status, 0);
 assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
});

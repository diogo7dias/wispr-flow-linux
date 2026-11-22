const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/patches/status-window-size.cjs');
const original = 'capture(s$.RA.prefs?.user.statusDockEdge??e$.We,p$.tD,p$.H8,586,d$,512)';
function fixture(t, code) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-window-test-'));
 t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
 const file = path.join(dir, 'index.js');
 fs.writeFileSync(file, code);
 return {file, run:() => spawnSync(process.execPath, [script, file])};
}

test('compact window is 140x44 on Linux, preserves other platforms, and is idempotent', t => {
 const {file, run} = fixture(t, original);
 assert.equal(run().status, 0);
 const code = fs.readFileSync(file, 'utf8');
 for (const platform of ['linux', 'win32', 'darwin']) {
  let geometry;
  vm.runInNewContext(code, {
   process:{platform}, s$:{RA:{prefs:{user:{}}}}, e$:{We:'bottom'},
   p$:{tD:false,H8:false}, d$:0, capture:(...args) => {geometry=args;},
  });
  assert.equal(geometry[3], platform === 'linux' ? 44 : 586);
  assert.equal(geometry[5], platform === 'linux' ? 140 : 512);
 }
 assert.equal(run().status, 0);
 assert.equal(fs.readFileSync(file, 'utf8'), code);
});

test('previous compact dimensions migrate to the accepted size', t => {
 const code = original.replace('586,d$,512',
  '/*WISPR_LINUX_COMPACT_STATUS_WINDOW*/"linux"===process.platform?100:586,d$,"linux"===process.platform?360:512');
 const {file, run} = fixture(t, code);
 assert.equal(run().status, 0);
 assert.match(fs.readFileSync(file, 'utf8'), /\?44:586,d\$,.*\?140:512/);
});

test('missing, ambiguous, or changed geometry fails without modifying the file', t => {
 for (const code of ['void 0', original+';'+original,
  '/*WISPR_LINUX_COMPACT_STATUS_WINDOW*/void 0']) {
  const {file, run} = fixture(t, code);
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), code);
 }
});

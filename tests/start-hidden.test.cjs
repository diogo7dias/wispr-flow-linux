const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
test('Linux launch is hidden, explicit launch and other platforms retain behavior', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-hidden-test-'));
 t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
 const file = path.join(dir, 'main.js');
 fs.writeFileSync(file, 'const c=()=>r.app.isPackaged?a.RA.prefs?.isUpdating?(s().info("Not showing hub window at launch: app is updating"),false):true:true;');
 const script = path.resolve(__dirname, '../scripts/patches/start-hidden.cjs');
 assert.equal(spawnSync(process.execPath, [script,file]).status, 0);
 const code = fs.readFileSync(file, 'utf8');
 const run = (platform, argv) => vm.runInNewContext(code+'c()', {
  process:{platform,argv}, r:{app:{isPackaged:true}},
  a:{RA:{prefs:{isUpdating:false}}}, s:()=>({info(){}})
 });
 assert.equal(run('linux', []), false);
 assert.equal(run('linux', ['--show-hub']), true);
 assert.equal(run('darwin', []), true);
 assert.equal(spawnSync(process.execPath, [script,file]).status, 0);
 assert.equal(fs.readFileSync(file,'utf8'), code);
});

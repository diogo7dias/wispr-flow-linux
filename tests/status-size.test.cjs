const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
test('70 percent scale migrates 50 percent and remains idempotent', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-size-test-'));
 t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
 const file = path.join(dir, 'index.html');
 fs.writeFileSync(file, '<html><head><style id="WISPR_LINUX_STATUS_HALF_SIZE">body{transform:scale(0.5)}</style></head><body></body></html>');
 const script = path.resolve(__dirname, '../scripts/patches/status-size.cjs');
 assert.equal(spawnSync(process.execPath, [script,file]).status, 0);
 const html = fs.readFileSync(file,'utf8');
 assert.match(html, /scale\(0\.7\)/);
 assert.doesNotMatch(html, /HALF_SIZE|scale\(0\.5\)/);
 assert.equal(spawnSync(process.execPath, [script,file]).status, 0);
 assert.equal(fs.readFileSync(file,'utf8'), html);
});

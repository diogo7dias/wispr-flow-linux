'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {transaction, recover, inspectTree} = require('../scripts/safe-update.cjs');
test('server JSON parsing errors are not confused with startup failures', () => {
  const {startupFailed} = require('../scripts/safe-update.cjs');
  assert.equal(startupFailed("SyntaxError: Unexpected token '<', is not valid JSON"), false);
  for (const text of ['Uncaught SyntaxError: invalid token',
    'Error initializing media recorder', 'Cannot find module foo'])
    assert.equal(startupFailed(text), true);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-update-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const root = path.join(dir, 'install'), candidate = path.join(dir, 'candidate');
  fs.mkdirSync(path.join(root, 'AppDir'), {recursive:true});
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(root, 'AppDir', 'version'), 'old');
  fs.writeFileSync(path.join(candidate, 'version'), 'new');
  const hooks = {stopped(){}, validate:inspectTree, preflight(){}, async smoke(){}};
  const version = () => fs.readFileSync(path.join(root, 'AppDir', 'version'), 'utf8');
  return {root, candidate, hooks, version};
}
test('successful update retains previous bytes', async t => {
  const f = fixture(t), tx = await transaction(f.root, f.candidate, f.hooks);
  assert.equal(f.version(), 'new');
  assert.equal(fs.readFileSync(path.join(tx, 'previous/version'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(f.root, 'pending-update')), false);
});
test('failed startup restores old build and preserves rejected candidate', async t => {
  const f = fixture(t); f.hooks.smoke = async () => { throw Error('startup failed'); };
  await assert.rejects(transaction(f.root, f.candidate, f.hooks), /startup failed/);
  assert.equal(f.version(), 'old');
  const tx = fs.readdirSync(f.root).find(n => n.startsWith('.update-'));
  assert.equal(fs.readFileSync(path.join(f.root, tx, 'rejected/version'), 'utf8'), 'new');
});
for (const point of ['stopped', 'validate', 'preflight']) {
  test(point + ' failure cannot replace installation', async t => {
    const f = fixture(t); f.hooks[point] = () => { throw Error(point); };
    await assert.rejects(transaction(f.root, f.candidate, f.hooks));
    assert.equal(f.version(), 'old');
    assert.deepEqual(fs.readdirSync(f.root), ['AppDir']);
  });
}
test('modified staged bytes rejected before renames', async t => {
  const f = fixture(t); let calls = 0;
  f.hooks.validate = root => inspectTree(root) + calls++;
  await assert.rejects(transaction(f.root, f.candidate, f.hooks), /changed/);
  assert.equal(f.version(), 'old');
});
test('recovery handles interruption between the two renames', t => {
  const f = fixture(t), tx = path.join(f.root, '.update-test123');
  fs.mkdirSync(tx);
  fs.writeFileSync(path.join(f.root, 'pending-update'), '.update-test123');
  fs.renameSync(path.join(f.root, 'AppDir'), path.join(tx, 'previous'));
  recover(f.root, () => {});
  assert.equal(f.version(), 'old');
});
test('recovery handles interruption before first rename', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'pending-update'), '.update-test123');
  recover(f.root, () => {});
  assert.equal(f.version(), 'old');
});
test('unsafe recovery paths and symlinked candidates rejected', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'pending-update'), '../outside');
  assert.throws(() => recover(f.root, () => {}), /Invalid/);
  fs.symlinkSync('/etc/passwd', path.join(f.candidate, 'link'));
  assert.throws(() => inspectTree(f.candidate), /regular/);
});

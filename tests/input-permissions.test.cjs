'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const file = path.join(__dirname, '../local/70-wispr-flow-uinput.rules');
const lines = fs.readFileSync(file, 'utf8').split('\n')
  .filter(line => line && !line.startsWith('#'));
test('event access is explicitly limited to keyboard/mouse/touchpad classes', () => {
  const events = lines.filter(line => line.includes('SUBSYSTEM=="input"'));
  assert.equal(events.length, 3);
  for (const category of ['KEYBOARD', 'MOUSE', 'TOUCHPAD']) {
    assert.equal(events.filter(line => line.includes(`ENV{ID_INPUT_${category}}=="1"`)).length, 1);
  }
  for (const line of events) assert.match(line, /TAG\+="uaccess"/);
  assert.ok(lines.every(line => !line.includes('GROUP="input"')));
});
test('paste retains active-seat uinput access without an input-group grant', () => {
  const line = lines.find(line => line.includes('KERNEL=="uinput"'));
  assert.ok(line);
  assert.match(line, /TAG\+="uaccess"/);
  assert.match(line, /GROUP="root"/);
  assert.match(line, /MODE="0660"/);
});
test('udev accepts the policy syntax', t => {
  const result = spawnSync('udevadm', ['verify', file], {encoding:'utf8'});
  if (result.error?.code === 'ENOENT') { t.skip('udevadm unavailable'); return; }
  assert.equal(result.status, 0, result.stderr);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const install = require('../scripts/patches/audio-refresh-runtime.cjs');
function clock() {
  let now = 0, next = 0;
  const timers = new Map(), intervals = new Map(), warnings = [];
  return {
    now: () => now,
    setTimeout: fn => { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = ++next; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    warn: message => warnings.push(message),
    tick(time) { now = time; for (const fn of intervals.values()) fn(); },
    async flush() { const jobs = [...timers.values()]; timers.clear(); await Promise.all(jobs.map(fn => fn())); },
    timers, intervals, warnings,
  };
}
test('device bursts coalesce into one refresh', async () => {
  const env = clock(); let calls = 0;
  const api = install({handleDeviceChange: async () => { calls++; }}, env);
  for (let i = 0; i < 100; i++) api.changed();
  assert.equal(env.timers.size, 1);
  await env.flush(); assert.equal(calls, 1);
});
test('browser timer functions are not invoked with the adapter as receiver', async () => {
  const env = clock();
  for (const name of ['setTimeout','clearTimeout','setInterval','clearInterval']) {
    const fn = env[name];
    env[name] = function(...args) { assert.equal(this, undefined); return fn(...args); };
  }
  const api = install({handleDeviceChange:async()=>{}},env);
  api.changed(); api.changed(); await env.flush(); api.dispose();
});
test('events during refresh produce one sequential follow-up', async () => {
  const env = clock(); let calls = 0, release;
  const api = install({handleDeviceChange: () => { calls++; return new Promise(r => { release = r; }); }}, env);
  api.changed(); const first = env.flush();
  api.changed(); api.changed();
  assert.equal(calls, 1); assert.equal(env.timers.size, 0);
  release(); await first; assert.equal(env.timers.size, 1);
  const second = env.flush(); assert.equal(calls, 2); release(); await second;
});
test('normal ticks do nothing; wake gap refreshes without starting a recording', async () => {
  const env = clock(); let calls = 0;
  install({handleDeviceChange: async () => { calls++; }}, env);
  env.tick(5000); env.tick(10000); await env.flush(); assert.equal(calls, 0);
  env.tick(60000); await env.flush(); assert.equal(calls, 1);
  env.tick(65000); await env.flush(); assert.equal(calls, 1);
});
test('failure is contained, logged without device data, and later events still work', async () => {
  const env = clock(); let calls = 0;
  const api = install({handleDeviceChange: async () => { if (++calls === 1) throw Error('private device label'); }}, env);
  api.changed(); await env.flush();
  assert.deepEqual(env.warnings, ['Linux audio device refresh failed']);
  assert.equal(env.timers.size, 0);
  api.changed(); await env.flush(); assert.equal(calls, 2);
});
test('disposal clears timers and prevents follow-up after in-flight work', async () => {
  const env = clock(); let release;
  const api = install({handleDeviceChange: () => new Promise(r => { release = r; })}, env);
  api.changed(); const flight = env.flush(); api.changed(); api.dispose();
  release(); await flight; api.changed();
  assert.equal(env.timers.size, 0); assert.equal(env.intervals.size, 0);
});
const patch = path.resolve(__dirname, '../scripts/patches/audio-refresh.cjs');
const fixture = '"linux"===window.electron.platform.os;class $Media{static setupDeviceChangeListener(){navigator.mediaDevices.ondevicechange=async()=>{$Log.m.info("Media device change detected"),await $Media.handleDeviceChange()}}}';
test('patch handles dollar identifiers, is idempotent, and preserves non-Linux behavior', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-audio-test-'));
  try {
    const file = path.join(dir, 'index.js'); fs.writeFileSync(file, fixture);
    assert.equal(spawnSync(process.execPath, [patch, file]).status, 0);
    const once = fs.readFileSync(file, 'utf8');
    assert.equal(spawnSync(process.execPath, [patch, file]).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    let logs = 0;
    const context = {window: {electron: {platform: {os:'darwin'}}}, navigator:{mediaDevices:{}}, $Log:{m:{info(){logs++;}}}};
    vm.runInNewContext(once + ';$Media.handleDeviceChange=async()=>{};$Media.setupDeviceChangeListener();navigator.mediaDevices.ondevicechange();', context);
    assert.equal(logs, 1);
    const env = clock(); let unload;
    const linux = {window:{electron:{platform:{os:'linux'}},addEventListener:(_name, fn)=>{unload=fn;}},navigator:{mediaDevices:{}},$Log:{m:{info(){},warn(){}}},setTimeout:env.setTimeout,clearTimeout:env.clearTimeout,setInterval:env.setInterval,clearInterval:env.clearInterval};
    vm.runInNewContext(once + ';$Media.setupDeviceChangeListener();$Media.setupDeviceChangeListener();', linux);
    assert.equal(env.intervals.size, 1);
    assert.equal(typeof linux.navigator.mediaDevices.ondevicechange, 'function');
    unload(); assert.equal(env.intervals.size, 0);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
test('missing or ambiguous anchors fail without changing the input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-audio-test-'));
  try {
    const file = path.join(dir, 'index.js');
    for (const input of ['const untouched=1;', fixture + fixture]) {
      fs.writeFileSync(file, input);
      assert.notEqual(spawnSync(process.execPath, [patch, file]).status, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), input);
    }
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

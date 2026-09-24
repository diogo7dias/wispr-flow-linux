'use strict';
// Exercises the payload that is shipped prepended to the app's main bundle.
// The payload is an IIFE with no exports, so it is evaluated in a VM with
// stubbed builtins and its test surface (__wisprStatusBroadcast) is read back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const PAYLOAD = path.join(__dirname, '..', 'scripts', 'patches', 'status-broadcast-runtime.js');
const source = fs.readFileSync(PAYLOAD, 'utf8');

// Objects built inside the VM realm have a different prototype chain, so
// compare their contents rather than their identity.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function frame(envelope) {
  const body = JSON.stringify(envelope, null, 2);
  return body.replace(/\+/g, '+1').replace(/\|/g, '+2') + '|';
}

// Loads the payload with the given runtime stubs and returns its test surface.
function load({runtimeDir, electron, spawn} = {}) {
  const writes = [];
  const dir = runtimeDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-broadcast-'));
  if (!runtimeDir) fs.rmSync(dir, {recursive: true, force: true});
  const realFs = {
    mkdirSync: (target, options) => fs.mkdirSync(target, options),
    writeFileSync: (target, body, options) => {
      writes.push({target, body});
      fs.writeFileSync(target, body, options);
    },
    renameSync: (from, to) => fs.renameSync(from, to),
  };
  const childProcess = spawn ? {spawn} : require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const sandbox = {
    process: {
      type: 'browser',
      env: {XDG_RUNTIME_DIR: dir},
      getBuiltinModule: name => {
        if (name === 'node:fs') return realFs;
        if (name === 'node:os') return os;
        if (name === 'node:path') return path;
        if (name === 'node:child_process') return childProcess;
        throw new Error('unexpected builtin ' + name);
      },
    },
    require: name => {
      if (name !== 'electron') throw new Error('unexpected require ' + name);
      if (!electron) throw new Error('no electron in this sandbox');
      return electron;
    },
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, {filename: PAYLOAD});
  const api = sandbox.__wisprStatusBroadcast;
  assert.ok(api, 'payload must expose its test surface');
  return {api, writes, dir, childProcess, originalSpawn: originalSpawn};
}

test('payload evaluates without installing when electron is unavailable', () => {
  const {api} = load();
  assert.equal(typeof api.install, 'function');
  assert.equal(api.install(), null);
  assert.equal(api.mapState('listening'), 'listening');
});

test('dictation states collapse onto the four bar states', () => {
  const {api} = load();
  assert.equal(api.mapState('initializing'), 'listening');
  assert.equal(api.mapState('listening'), 'listening');
  assert.equal(api.mapState('stopping'), 'transcribing');
  assert.equal(api.mapState('processing'), 'transcribing');
  assert.equal(api.mapState('retrying'), 'transcribing');
  assert.equal(api.mapState('error'), 'error');
  assert.equal(api.mapState('idle'), 'idle');
  assert.equal(api.mapState('dismissed'), 'idle');
  assert.equal(api.mapState(undefined), 'idle');
});

test('a PasteText request yields the exact text handed to the helper', () => {
  const {api} = load();
  const text = 'pipes | plus + newlines\n\u00e9\u00e7\u00e3o';
  const seen = [];
  const rest = api.parseStream('', frame({
    HelperAPIRequest: {PasteText: {payload: {pasteId: 'a1', text}}},
  }), 'out', message => seen.push(message));
  assert.deepEqual(plain(seen), [{type: 'text', text}]);
  assert.equal(rest, '');
});

test('chunk boundaries neither lose nor duplicate messages', () => {
  const {api} = load();
  const stream = frame({HelperAPIRequest: {PasteText: {payload: {text: 'one'}}}}) +
    frame({HelperAPIResponse: {PasteOutcome: {payload: {success: true}}}});
  const seen = [];
  let buffer = '';
  for (const chunk of [stream.slice(0, 17), stream.slice(17, 40), stream.slice(40)])
    buffer = api.parseStream(buffer, chunk, 'out', message => seen.push(message));
  assert.deepEqual(plain(seen), [{type: 'text', text: 'one'}, {type: 'outcome', success: true}]);
});

test('blocked, failed and successful pastes are all reported', () => {
  const {api} = load();
  const report = envelope => {
    const seen = [];
    api.parseStream('', envelope, 'in', message => seen.push(message));
    return seen;
  };
  assert.deepEqual(plain(report(frame({HelperAPIResponse: {PasteBlocked: {payload: {reason: 'locked'}}}}))),
    [{type: 'outcome', success: false}]);
  assert.deepEqual(plain(report(frame({HelperAPIResponse: {PasteOutcome: {payload: {success: false}}}}))),
    [{type: 'outcome', success: false}]);
  assert.deepEqual(plain(report(frame({HelperAPIResponse: {PasteOutcome: {payload: {success: true}}}}))),
    [{type: 'outcome', success: true}]);
});

test('malformed frames are skipped without dropping their successors', () => {
  const {api} = load();
  const seen = [];
  api.parseStream('', '{ this is not json|' +
    frame({HelperAPIRequest: {PasteText: {payload: {text: 'kept'}}}}), 'out',
  message => seen.push(message));
  assert.deepEqual(plain(seen), [{type: 'text', text: 'kept'}]);
});

test('unrelated helper traffic is ignored', () => {
  const {api} = load();
  const seen = [];
  api.parseStream('', frame({HelperAPIRequest: {IsReady: true, uuid: 'x'}}) +
    frame({HelperAPIResponse: {ACK: true, uuid: 'x'}}) +
    frame({HelperAPIRequest: {KeypressEvent: {keycode: 1}}}), 'out',
  message => seen.push(message));
  assert.deepEqual(plain(seen), []);
});

test('channel traffic drives state, level and the write cadence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-broadcast-'));
  try {
    const {api, writes} = load({runtimeDir: dir});
    const bridge = api.create({
      fs: {
        mkdirSync: (target, options) => fs.mkdirSync(target, options),
        writeFileSync: (target, body, options) => { writes.push({target, body}); },
        renameSync: () => {},
      },
      os, path, childProcess: require('node:child_process'), electron: {},
    });
    bridge.publish(true);
    assert.equal(writes.length, 1, 'an idle publish lands immediately');
    // Levels are throttled to one write per 60 ms window, so a synchronous
    // burst of points lands as a single frame.
    for (let i = 0; i < 40; i++) bridge.applyChannel('status:audioLevel', i / 40);
    assert.equal(writes.length, 1, 'a level burst inside one window is dropped');
    await new Promise(resolve => setTimeout(resolve, 80));
    bridge.applyChannel('status:audioLevel', 1);
    assert.equal(writes.length, 2, 'the next window publishes again');
    assert.equal(JSON.parse(writes[1].body).level, 1);
    // Every transition lands immediately, whether or not a level just did.
    bridge.applyChannel('status:dictationStatus', 'listening');
    bridge.applyChannel('status:dictationStatus', 'processing');
    assert.equal(writes.length, 4);
    assert.equal(JSON.parse(writes[3].body).state, 'transcribing');
    // A repeat of the same state is not a transition.
    bridge.applyChannel('status:dictationStatus', 'processing');
    assert.equal(writes.length, 4);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a new recording clears the previous transcript and outcome', () => {
  const {api} = load();
  const bridge = api.create({
    fs: {mkdirSync() {}, writeFileSync() {}, renameSync() {}},
    os, path, childProcess: require('node:child_process'), electron: {},
  });
  bridge.applyMessage({type: 'text', text: 'first sentence'});
  bridge.applyMessage({type: 'outcome', success: true});
  assert.equal(bridge.state.text, 'first sentence');
  assert.equal(bridge.state.pasted, true);
  bridge.applyChannel('status:dictationStatus', 'listening');
  assert.equal(bridge.state.text, '');
  assert.equal(bridge.state.pasted, null);
});

test('an unwritable runtime dir leaves state intact', () => {
  const {api} = load();
  const bridge = api.create({
    fs: {
      mkdirSync() { throw new Error('read-only'); },
      writeFileSync() {},
      renameSync() {},
    },
    os, path, childProcess: require('node:child_process'), electron: {},
  });
  bridge.applyMessage({type: 'text', text: 'still here'});
  assert.equal(bridge.state.text, 'still here');
});

test('the webContents patch calls the original send through intact', () => {
  const {api} = load();
  const calls = [];
  const proto = {send(channel, value) { calls.push([channel, value]); return 'sent'; }};
  const bridge = api.create({
    fs: {mkdirSync() {}, writeFileSync() {}, renameSync() {}},
    os, path, childProcess: require('node:child_process'), electron: {},
  });
  bridge.patchWebContents(Object.create(proto));
  assert.equal(proto.send('status:dictationStatus', 'listening'), 'sent');
  assert.deepEqual(calls, [['status:dictationStatus', 'listening']]);
  assert.equal(bridge.state.state, 'listening');
});

test('the helper transport tap reads stdin requests and fd 3 replies', () => {
  const {api} = load();
  const stdinWrites = [];
  const listeners = {};
  const child = {
    stdin: {write(chunk) { stdinWrites.push(String(chunk)); return true; }},
    stdio: [null, null, null, {on: (event, handler) => { listeners[event] = handler; }}],
  };
  const childProcess = {
    spawn: () => child,
  };
  const bridge = api.create({
    fs: {mkdirSync() {}, writeFileSync() {}, renameSync() {}},
    os, path, childProcess, electron: {},
  });
  bridge.patchSpawn();
  const spawned = childProcess.spawn('/opt/wispr/wispr-flow-linux-helper');
  assert.equal(spawned, child);
  spawned.stdin.write(frame({HelperAPIRequest: {PasteText: {payload: {text: 'hello world'}}}}));
  assert.equal(bridge.state.text, 'hello world');
  assert.equal(bridge.state.pasted, null);
  listeners.data(frame({HelperAPIResponse: {PasteOutcome: {payload: {success: true}}}}));
  assert.equal(bridge.state.pasted, true);
});

test('spawn is only instrumented for the helper binary', () => {
  const {api} = load();
  const other = {stdin: {write() {}}, stdio: []};
  const childProcess = {spawn: () => other};
  const bridge = api.create({
    fs: {mkdirSync() {}, writeFileSync() {}, renameSync() {}},
    os, path, childProcess, electron: {},
  });
  bridge.patchSpawn();
  childProcess.spawn('/usr/bin/pactl');
  assert.equal(other.stdin.write('x'), undefined, 'non-helper stdin is untouched');
});

test('install wires the electron app and publishes an initial snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispr-broadcast-'));
  try {
    const handlers = {};
    const written = [];
    const electron = {
      app: {
        on: (event, handler) => { handlers[event] = handler; },
        whenReady: () => Promise.resolve(),
      },
      webContents: {getAllWebContents: () => []},
    };
    const {api} = load({runtimeDir: dir, electron});
    const realWrite = fs.writeFileSync;
    const report = api.install();
    assert.ok(report, 'install returns the live bridge inside the app');
    assert.equal(typeof handlers['web-contents-created'], 'function');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'wispr-flow', 'status.json'), 'utf8')),
      {state: 'idle', level: 0, text: '', pasted: null, ts: report.state.ts});
    const mode = fs.statSync(path.join(dir, 'wispr-flow', 'status.json')).mode & 0o777;
    assert.equal(mode, 0o600, 'the transcript file is private to the user');
    assert.equal(realWrite, fs.writeFileSync);
    assert.deepEqual(written, []);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
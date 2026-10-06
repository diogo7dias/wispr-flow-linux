// WISPR_LINUX_STATUS_BROADCAST_RUNTIME
//
// Payload prepended to the app's main bundle by
// scripts/patches/status-broadcast.cjs. It publishes Wispr Flow's dictation
// state for the Omarchy bar widget (local/omarchy/ddm.wispr).
//
// OBSERVE ONLY. Every hook calls the original implementation through, nothing
// is written on the app's behalf, and no account file, database, clipboard,
// helper socket or log is read. The single output is
// $XDG_RUNTIME_DIR/wispr-flow/status.json, mode 0600:
//
//   state   idle | listening | transcribing | error
//   level   0..1 microphone level the app already computes for its own pill
//   text    the exact string the app handed the helper for paste
//   pasted  true/false once the helper reports an outcome, null before that
//   ts      ms epoch of the last publish
//
// Two hooks, both on generic Node/Electron surfaces rather than app internals,
// so they survive the app re-minifying on every upstream release:
//   1. WebContents.prototype.send — the app's own status:* channels.
//   2. child_process.spawn — taps the helper's stdio pair for PasteText out
//      and PasteOutcome / PasteBlocked back.
(function () {
  'use strict';

  var LEVEL_INTERVAL_MS = 60;
  var TEXT_LIMIT = 8000;

  // The app's DictationStatus enum values arrive as strings; the bar only
  // needs the three states it draws plus an error.
  function mapState(status) {
    switch (status) {
      case 'initializing':
      case 'listening':
        return 'listening';
      case 'stopping':
      case 'processing':
      case 'retrying':
        return 'transcribing';
      case 'error':
        return 'error';
      default:
        return 'idle';
    }
  }

  // Helper wire framing: bodies are pretty-printed JSON, joined with "|", and
  // escaped with "+" (+1 for a plus, +2 for the delimiter).
  function unescapeBody(body) {
    return String(body).replace(/\+2/g, '|').replace(/\+1/g, '+');
  }

  // Feeds protocol bytes in and reports only what the bar cares about.
  // direction "out" is Electron -> helper (stdin), "in" is fd 3.
  function parseStream(buffer, chunk, direction, onMessage) {
    var data = buffer + chunk;
    var parts = data.split('|');
    data = parts.pop();
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var envelope;
      try {
        envelope = JSON.parse(unescapeBody(parts[i]));
      } catch (error) {
        continue;
      }
      if (!envelope || typeof envelope !== 'object') continue;
      var body = envelope.HelperAPIRequest || envelope.HelperAPIResponse;
      if (!body || typeof body !== 'object') continue;
      if (direction === 'out' && body.PasteText) {
        var payload = body.PasteText.payload || {};
        onMessage({type: 'text', text: String(payload.text == null ? '' : payload.text)});
      } else if (body.PasteOutcome) {
        var outcome = body.PasteOutcome.payload || {};
        onMessage({type: 'outcome', success: outcome.success === true});
      } else if (body.PasteBlocked) {
        onMessage({type: 'outcome', success: false});
      }
    }
    return data;
  }

  function create(options) {
    var fs = options.fs;
    var os = options.os;
    var path = options.path;
    var childProcess = options.childProcess;
    var electron = options.electron;
    var directory = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'wispr-flow');
    var file = path.join(directory, 'status.json');
    var temp = path.join(directory, 'status.json.tmp');
    var state = {state: 'idle', level: 0, text: '', pasted: null, ts: Date.now()};
    var lastLevelWrite = 0;
    var patchedWindow = false;
    var patchedSpawn = false;

    function publish(force) {
      var now = Date.now();
      if (!force && now - lastLevelWrite < LEVEL_INTERVAL_MS) return;
      lastLevelWrite = now;
      state.ts = now;
      try {
        fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        fs.writeFileSync(temp, JSON.stringify(state), {mode: 0o600});
        fs.renameSync(temp, file);
      } catch (error) {
        // A missing runtime dir or a full disk must never disturb dictation.
      }
    }

    function applyMessage(message) {
      if (message.type === 'text') {
        state.text = message.text.slice(0, TEXT_LIMIT);
        state.pasted = null;
        publish(true);
      } else if (message.type === 'outcome') {
        state.pasted = message.success;
        publish(true);
      }
    }

    function applyChannel(channel, value) {
      if (channel === 'status:dictationStatus') {
        var next = mapState(value);
        if (next === state.state) return;
        state.state = next;
        // A new recording starts a new transcript; keep the previous one only
        // until the new text arrives, so a click never copies stale words.
        if (next === 'listening') {
          state.pasted = null;
          state.text = '';
        }
        publish(true);
      } else if (channel === 'status:audioLevel') {
        var level = Number(value);
        if (!Number.isFinite(level)) return;
        // Published untouched: the app's own scale, so the consumer decides how
        // to render it instead of inheriting a clamp that hides the range.
        state.level = level;
        publish(false);
      }
    }

    // One prototype patch covers every window the app will ever create, and
    // keeps working while the app's own status window stays hidden.
    function patchWebContents(contents) {
      if (!contents || patchedWindow) return;
      var proto = Object.getPrototypeOf(contents);
      if (!proto || typeof proto.send !== 'function') return;
      var send = proto.send;
      proto.send = function bridgedSend(channel) {
        try {
          applyChannel(channel, arguments[1]);
        } catch (error) {}
        return send.apply(this, arguments);
      };
      patchedWindow = true;
    }

    // The helper is respawned on demand, so the wrapper has to persist.
    function patchSpawn() {
      if (patchedSpawn || !childProcess || typeof childProcess.spawn !== 'function') return;
      var spawn = childProcess.spawn;
      childProcess.spawn = function bridgedSpawn(command) {
        var child = spawn.apply(this, arguments);
        try {
          if (!child || !/wispr-flow-linux-helper$/.test(String(command))) return child;
          var outbound = '';
          var inbound = '';
          if (child.stdin && typeof child.stdin.write === 'function') {
            var write = child.stdin.write;
            child.stdin.write = function bridgedWrite(chunk) {
              try {
                outbound = parseStream(outbound, String(chunk), 'out', applyMessage);
              } catch (error) {}
              return write.apply(this, arguments);
            };
          }
          var channel = child.stdio && child.stdio[3];
          if (channel && typeof channel.on === 'function') {
            channel.on('data', function (chunk) {
              try {
                inbound = parseStream(inbound, String(chunk), 'in', applyMessage);
              } catch (error) {}
            });
          }
        } catch (error) {}
        return child;
      };
      patchedSpawn = true;
    }

    return {
      state: state,
      publish: publish,
      applyChannel: applyChannel,
      applyMessage: applyMessage,
      patchWebContents: patchWebContents,
      patchSpawn: patchSpawn,
    };
  }

  function install() {
    var electron = null;
    try {
      electron = require('electron');
    } catch (error) {}
    if (!electron || !electron.app || !electron.app.on) return null;
    var bridge = create({
      fs: process.getBuiltinModule('node:fs'),
      os: process.getBuiltinModule('node:os'),
      path: process.getBuiltinModule('node:path'),
      childProcess: process.getBuiltinModule('node:child_process'),
      electron: electron,
    });
    electron.app.on('web-contents-created', function (event, contents) {
      bridge.patchWebContents(contents);
    });
    if (typeof electron.app.whenReady === 'function') {
      electron.app.whenReady().then(function () {
        try {
          var all = electron.webContents.getAllWebContents();
          for (var i = 0; i < all.length; i++) bridge.patchWebContents(all[i]);
        } catch (error) {}
      });
    }
    bridge.patchSpawn();
    bridge.publish(true);
    return bridge;
  }

  globalThis.__wisprStatusBroadcast = {
    mapState: mapState,
    unescapeBody: unescapeBody,
    parseStream: parseStream,
    create: create,
    install: install,
  };

  try {
    install();
  } catch (error) {
    // Never take the app down over a status indicator.
  }
})();
#!/usr/bin/env node
'use strict';
// Explicit allowlist output. Never read account files, clipboard data or logs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
function command(binary, args) {
  const r = spawnSync(binary, args, {encoding:'utf8', timeout:3000, maxBuffer:1024*1024});
  return r.status === 0 ? r.stdout : null;
}
function audioSummary(text) {
  try {
    const sources = JSON.parse(text);
    if (!Array.isArray(sources)) return {available:false};
    const microphones = sources.filter(s => s.monitor_of_sink === null ||
      s.monitor_of_sink === 4294967295 || s.monitor_of_sink === undefined);
    return {available:true, microphones:microphones.length,
      unmuted:microphones.filter(s => s.mute === false).length};
  } catch { return {available:false}; }
}
function canOpen(file, flags) {
  try { const fd=fs.openSync(file,flags|fs.constants.O_NONBLOCK);fs.closeSync(fd);return true; }
  catch { return false; }
}
function report() {
  const root = path.join(os.homedir(), '.local/share/wispr-flow/AppDir');
  const base = path.join(root, 'usr/lib/wispr-flow');
  const result = {schema:1, session: process.env.WAYLAND_DISPLAY ? 'wayland' :
    process.env.DISPLAY ? 'x11' : 'headless',
    appRunning:false, helperRunning:false, helperRawInputDescriptors:0};
  for (const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))) {
    try {
      const exe = fs.readlinkSync('/proc/'+pid+'/exe');
      if (exe === path.join(base,'wispr-flow')) result.appRunning=true;
      if (exe !== path.join(base,'resources/Release/wispr-flow-linux-helper')) continue;
      result.helperRunning=true;
      for (const fd of fs.readdirSync('/proc/'+pid+'/fd')) {
        try { if (fs.readlinkSync('/proc/'+pid+'/fd/'+fd).startsWith('/dev/input/'))
          result.helperRawInputDescriptors++; } catch {}
      }
    } catch {}
  }
  result.uinputWritable = canOpen('/dev/uinput',fs.constants.O_WRONLY);
  const shortcuts = command('hyprctl',['globalshortcuts']) || '';
  result.compositorShortcutsRegistered = shortcuts.includes('wispr-flow:dictate') &&
    shortcuts.includes('wispr-flow:cancel');
  result.audio = audioSummary(command('pactl',['--format=json','list','sources']));
  const group = command('getent',['group','input']);
  const gid = Number(group?.split(':')[2]);
  result.sessionHasInputGroup = Number.isInteger(gid) && process.getgroups().includes(gid);
  result.linuxPatchesPresent = spawnSync('bash',[path.join(__dirname,'verify-patches.sh'),
    path.join(base,'resources/app.asar')],{stdio:'ignore',timeout:5000}).status === 0;
  result.liveDictationTested = false;
  return result;
}
module.exports = {audioSummary, report};
if (require.main === module) console.log(JSON.stringify(report(),null,2));

#!/usr/bin/env node
const fs = require('node:fs');
const vm = require('node:vm');
const install = require('./audio-refresh-runtime.cjs');
const file = process.argv[2];
const marker = 'WISPR_LINUX_AUDIO_REFRESH_V1';
let code = fs.readFileSync(file, 'utf8');
if (code.includes(marker)) process.exit(0);
const pattern = /static setupDeviceChangeListener\(\)\{navigator\.mediaDevices\.ondevicechange=async\(\)=>\{([\w$]+)\.m\.info\("Media device change detected"\),await ([\w$]+)\.handleDeviceChange\(\)\}\}/g;
const matches = [...code.matchAll(pattern)];
if (matches.length !== 1) throw new Error('Expected one audio device listener; re-audit required');
// Discover the existing preload bridge without assuming a minified identifier.
const bridge = [...code.matchAll(/"linux"===([\w$]+)\.electron\.platform\.os/g)];
const names = [...new Set(bridge.map(m => m[1]))];
if (names.length !== 1) throw new Error('Expected one Linux platform bridge; re-audit required');
code = code.replace(pattern, (original, logger, media) =>
  `static setupDeviceChangeListener(){/*${marker}*/if("linux"!==${names[0]}.electron.platform.os){${original.slice(original.indexOf('{') + 1, -1)};return;}if(${media}.__linuxAudioRefresh)return;${media}.__linuxAudioRefresh=(${install.toString()})(${media},{now:()=>Date.now(),setTimeout,clearTimeout,setInterval,clearInterval,warn:m=>${logger}.m.warn(m)});navigator.mediaDevices.ondevicechange=${media}.__linuxAudioRefresh.changed;window.addEventListener("unload",()=>${media}.__linuxAudioRefresh.dispose(),{once:true});${logger}.m.info("Linux audio refresh ready");}`);
new vm.Script(code, {filename:file});
fs.writeFileSync(file, code);
console.log('Installed serialized audio device refresh and wake-gap refresh.');

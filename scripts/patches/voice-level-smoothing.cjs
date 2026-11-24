#!/usr/bin/env node
// The pill eases each new level in at 15 percent per frame (about 100 ms to
// catch up), so bars trail the voice. Ease at 40 percent per frame instead.
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
const marker = 'WISPR_LINUX_VOICE_LEVEL_SMOOTHING';
let code = fs.readFileSync(file, 'utf8');
if (code.includes(marker)) process.exit(0);
const ease = /const (\w+)=\.85\*(\w+)\+(\w+)\*\(1-\.85\);/g;
if ([...code.matchAll(ease)].length !== 1)
 throw new Error('Expected one waveform easing step; re-audit required');
code = code.replace(ease,
 (_m,out,prev,next) => `const ${out}=/*${marker}*/.6*${prev}+${next}*(1-.6);`);
new vm.Script(code, {filename:file});
fs.writeFileSync(file, code);
console.log('Waveform eases at 40 percent per frame.');

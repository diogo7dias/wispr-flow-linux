#!/usr/bin/env node
// The upstream display scaler saturates 20 dB above its lowest sample.
// Use a fixed dBFS range for visualization only; captured/uploaded audio is untouched.
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
let code = fs.readFileSync(file, 'utf8');
const marker = 'WISPR_LINUX_VOICE_LEVEL_RANGE';
if (code.includes(marker)) process.exit(0);
const pattern = /"wav"===([\w$]+)\)\{const ([\w$]+)=([\w$]+)\.scale\(([\w$]+)\);\(\(([\w$]+),([\w$]+)\)=>\{([\w$]+)\.push\(\6\)/g;
if ([...code.matchAll(pattern)].length !== 1)
 throw new Error('Expected one WAV display-level scaler; re-audit required');
code = code.replace(pattern, (_m,encoding,level,_scaler,raw,window,value,queue) =>
 `"wav"===${encoding}){const ${level}=/*${marker}*/Number.isFinite(${raw})?Math.max(0,Math.min(1,(${raw}+55)/50)):0;((${window},${value})=>{${queue}.push(${value})`);
new vm.Script(code, {filename:file});
fs.writeFileSync(file, code);
console.log('Display levels use -55 to -5 dBFS instead of a saturating adaptive floor.');

#!/usr/bin/env node
// Keep the existing microphone subscription and decay; remove decorative loops.
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
const marker = 'WISPR_LINUX_VOICE_WAVEFORM';
let code = fs.readFileSync(file, 'utf8');
if (code.includes(marker)) process.exit(0);
const loops = /(transform:scale[XY]\(calc\(var\(--(?:bar-)?audio-scale, 1\) \* var\(--bar-height-scale, 1\)(?: \* 1)?\)\);)animation:[\w]+ 1s infinite ease-in-out/g;
const scale = /const ([\w$]+)=([\w$]+)\.current\*([\w$]+),([\w$]+)=String\(([\w$]+)\.current\?Math.max\(1,\1\):\1\)/g;
const event = /([\w$]+)\(([\w$]+)\.LF.AudioLevel,([\w$]+)=>\{const ([\w$]+)=([\w$]+)\.current;\4&&!\4\(\3\)\|\|\(([\w$]+)\.current=\3,\3>0&&([\w$]+)\(\)\)\}\)/g;
for (const [pattern,count] of [[loops,4],[scale,1],[event,1]]) {
 if ([...code.matchAll(pattern)].length !== count)
  throw new Error('Voice waveform layout changed; re-audit required');
}
code = code.replace(loops, '$1animation:none');
code = code.replace(scale, (_m,n,gain,level,value,floor) =>
 `const ${n}=1+${gain}.current*${level},${value}=String(${floor}.current?Math.max(1,${n}):${n})`);
code = code.replace(event, (_m,subscribe,events,level,accept,ref,target,start) =>
 `${subscribe}(${events}.LF.AudioLevel,${level}=>{${level}=Number.isFinite(${level})&&${level}>.02?Math.min(1,${level}):0;const ${accept}=${ref}.current;${accept}&&!${accept}(${level})||(${target}.current=${level},${level}>0&&${start}())})`);
code = `/*${marker}*/\n` + code;
new vm.Script(code, {filename:file});
fs.writeFileSync(file, code);
console.log('Waveform uses microphone levels; decorative loops removed.');

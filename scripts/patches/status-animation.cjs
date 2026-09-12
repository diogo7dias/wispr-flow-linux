#!/usr/bin/env node
// Remove the status-only 20 Hz animation throttle. Its consumers use elapsed
// time, and the surrounding scheduler already stops when hidden/unsubscribed.
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
const marker = 'WISPR_LINUX_STATUS_DISPLAY_CADENCE';
let code = fs.readFileSync(file, 'utf8');
if (code.includes(marker)) process.exit(0);
const pattern = /([\w$]+)=\(\1\?\?([\w$]+)\)\+50,\1<\2\+25&&\(\1=\2\+50\);const ([\w$]+)=Math.max\(0,\1-performance.now\(\)-10\);([\w$]+)=setTimeout\(\(\)=>\{\4=null,([\w$]+)=requestAnimationFrame\(([\w$]+)\)\},\3\)/g;
const matches = [...code.matchAll(pattern)];
if (matches.length !== 1) throw new Error('Expected one 20 Hz ticker; re-audit required');
code = code.replace(pattern, (_match, _deadline, _time, _delay, _timer, frame, callback) =>
 `/*${marker}*/${frame}=requestAnimationFrame(${callback})`);
new vm.Script(code, {filename: file});
fs.writeFileSync(file, code);
console.log('Status animation now follows display cadence while active.');

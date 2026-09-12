#!/usr/bin/env node
// Suppress only the launch-time hub decision; explicit activation is unchanged.
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
const marker = 'WISPR_LINUX_START_HIDDEN';
let code = fs.readFileSync(file, 'utf8');
if (code.includes(marker)) process.exit(0);
const pattern = /const ([\w$]+)=\(\)=>([\w$]+)\.app\.isPackaged\?([\w$]+)\.RA\.prefs\?\.isUpdating\?\(([\w$]+)\(\)\.info\("Not showing hub window at launch: app is updating"\)/g;
if ([...code.matchAll(pattern)].length !== 1) {
 throw new Error('Expected one startup decision; re-audit required');
}
code = code.replace(pattern, (match, name) => match.replace(
 `const ${name}=()=>`,
 `const ${name}=()=>/*${marker}*/("linux"===process.platform&&!process.argv.includes("--show-hub"))?!1:`));
new vm.Script(code, {filename:file});
fs.writeFileSync(file, code);
console.log('Linux dashboard starts hidden unless --show-hub is requested.');

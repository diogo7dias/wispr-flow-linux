#!/usr/bin/env node
// Compact bottom-docked status canvas, with room for the expanded dictation bar.
const fs=require('node:fs');
const vm=require('node:vm');
const file=process.argv[2],marker='WISPR_LINUX_COMPACT_STATUS_WINDOW';
let code=fs.readFileSync(file,'utf8');
if(code.includes(marker)){
 const old=/\/\*WISPR_LINUX_COMPACT_STATUS_WINDOW\*\/"linux"===process\.platform\?100:586,([\w$]+),"linux"===process\.platform\?360:512/g;
 code=code.replace(old,(_m,side)=>`/*${marker}*/"linux"===process.platform?64:586,${side},"linux"===process.platform?320:512`);
 new vm.Script(code);fs.writeFileSync(file,code);process.exit(0);
}
const pattern=/([\w$]+)\.RA\.prefs\?\.user\.statusDockEdge\?\?([\w$]+)\.We,([\w$]+)\.tD,\3\.H8,586,([\w$]+),512\)/g;
if([...code.matchAll(pattern)].length!==1)throw Error('Status geometry changed; re-audit required');
code=code.replace(pattern,(_m,state,enums,platform,side)=>`${state}.RA.prefs?.user.statusDockEdge??${enums}.We,${platform}.tD,${platform}.H8,/*${marker}*/"linux"===process.platform?64:586,${side},"linux"===process.platform?320:512)`);
new vm.Script(code);fs.writeFileSync(file,code);

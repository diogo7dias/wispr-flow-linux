#!/usr/bin/env node
// Linux/Wayland cannot use global cursor polling for transparent hit testing.
const fs = require('node:fs');
const vm = require('node:vm');
const file = process.argv[2];
const marker = 'WISPR_LINUX_STATUS_INPUT_REGION';
let code = fs.readFileSync(file,'utf8');
if(code.includes(marker)) process.exit(0);
const poll=/const ([\w$]+)=([\w$]+)=>\{([\w$]+)\|\|\(([\w$]+)\(\),\2&&!\2\.isDestroyed\(\)&&\(([\w$]+)=\(0,([\w$]+)\.Bi\)\(\2\)\)\)\}/g;
const report=/if\(([\w$]+)\.H8\)\{if\(!([\w$]+)\.applyReport\(([\w$]+),([\w$]+)\)\)return;\(0,([\w$]+)\.cr\)\(([\w$]+),\4\.shapeRects\)\}\(0,\5\.cM\)\(\6,\4\.rects\)/g;
if([...code.matchAll(poll)].length!==1||[...code.matchAll(report)].length!==1)
 throw Error('Status hit-test layout changed; re-audit required');
code=code.replace(poll,(match,fn,win,suspended,stop)=>
 `const ${fn}=${win}=>{if("linux"===process.platform){${stop}();return;}return ${suspended}||`+
 match.slice(match.indexOf('||')+2,-1)+'}');
code=code.replace(report,(match,_platform,_shape,_sender,payload,_utils,win)=>
 `if("linux"===process.platform){const bounds=${win}.getContentBounds();const rects=[...${payload}.rects,...${payload}.shapeRects].slice(0,128).map(r=>{const x=Math.max(0,Math.floor(r.x)),y=Math.max(0,Math.floor(r.y));return{x,y,width:Math.min(bounds.width,Math.ceil(r.x+r.width))-x,height:Math.min(bounds.height,Math.ceil(r.y+r.height))-y}}).filter(r=>r.width>0&&r.height>0);${win}.setShape(rects.length?rects:[{x:0,y:0,width:1,height:1}]);${win}.setIgnoreMouseEvents(false);}`+match);
code=`/*${marker}*/\n`+code;
new vm.Script(code,{filename:file});fs.writeFileSync(file,code);
console.log('Linux status input follows validated renderer rectangles.');

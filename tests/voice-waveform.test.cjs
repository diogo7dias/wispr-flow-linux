const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
test('microphone gating, responsive scale, and no decorative loops', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wispr-voice-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file = path.join(dir,'index.js');
 const css = 'transform:scaleY(calc(var(--audio-scale, 1) * var(--bar-height-scale, 1)));animation:wave 1s infinite ease-in-out';
 fs.writeFileSync(file, `const css=${JSON.stringify(css.repeat(4))};
 function scale(e){const n=a.current*e,o=String(i.current?Math.max(1,n):n);return o}
 sub(events.LF.AudioLevel,e=>{const t=accept.current;t&&!t(e)||(target.current=e,e>0&&start())});`);
 const script=path.resolve(__dirname,'../scripts/patches/voice-waveform.cjs');
 assert.equal(spawnSync(process.execPath,[script,file]).status,0);
 const code=fs.readFileSync(file,'utf8');
 assert.doesNotMatch(code,/1s infinite/);
 let callback;
 const context={a:{current:5},i:{current:true},accept:{current:()=>true},
  target:{current:0},events:{LF:{AudioLevel:'audio'}},start(){},sub(_e,fn){callback=fn;}};
 vm.createContext(context);vm.runInContext(code,context);
 for(const value of [0,.01,.02,NaN,Infinity,-1]){callback(value);assert.equal(context.target.current,0);}
 callback(.2);assert.equal(context.target.current,.2);
 callback(3);assert.equal(context.target.current,1);
 assert.equal(vm.runInContext('scale(0)',context),'1');
 assert.equal(vm.runInContext('scale(.2)',context),'2');
 assert.equal(spawnSync(process.execPath,[script,file]).status,0);
 assert.equal(fs.readFileSync(file,'utf8'),code);
});

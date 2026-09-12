const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('visible bars respond to voice and settle after silence or lost events',()=>{
 let callback, pending, now=0;
 const properties=new Map();
 const bar={getBoundingClientRect:()=>({width:2}),style:{setProperty:(k,v)=>properties.set(k,v),removeProperty:k=>properties.delete(k)}};
 const context={Set,Math,Number,performance:{now:()=>now},
  requestAnimationFrame:fn=>{pending=fn;return 1;},cancelAnimationFrame(){},
  document:{readyState:'complete',querySelectorAll:()=>[bar],querySelector:()=>null},
  window:{electron:{ipc:{on:(_event,fn)=>{callback=fn;return 1;},off(){}}},addEventListener(){}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/patches/voice-bars-runtime.js'),'utf8'),context);
 callback(.1);assert.equal(pending,undefined);
 callback(.7);
 for(let i=0;i<8;i++){now+=16;const fn=pending;pending=undefined;fn(now);}
 assert.ok(Number(properties.get('transform').match(/\((.*)\)/)[1])>4);
 callback(0);
 for(let i=0;i<150&&pending;i++){now+=16;const fn=pending;pending=undefined;fn(now);}
 assert.equal(properties.size,0);assert.equal(pending,undefined);
 callback(.8);
 for(let i=0;i<200&&pending;i++){now+=16;const fn=pending;pending=undefined;fn(now);}
 assert.equal(properties.size,0);assert.equal(pending,undefined);
});

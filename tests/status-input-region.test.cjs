const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
test('Linux skips global polling and clamps the reported input shape',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wispr-input-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'main.js');
 fs.writeFileSync(file,'const poll=win=>{suspended||(stop(),win&&!win.isDestroyed()&&(poller=(0,utils.Bi)(win)))};function report(){if(platform.H8){if(!shape.applyReport(sender,payload))return;(0,utils.cr)(win,payload.shapeRects)}(0,utils.cM)(win,payload.rects)}');
 const script=path.resolve(__dirname,'../scripts/patches/status-input-region.cjs');
 assert.equal(spawnSync(process.execPath,[script,file]).status,0);
 const code=fs.readFileSync(file,'utf8');let actual,ignored,stops=0;
 const context={process:{platform:'linux'},suspended:false,stop(){stops++},
  win:{getContentBounds:()=>({width:100,height:100}),setShape:r=>actual=r,setIgnoreMouseEvents:v=>ignored=v},
  payload:{rects:[{x:-3,y:80,width:20,height:40}],shapeRects:[]},platform:{H8:false},utils:{cM(){},Bi(){throw Error('must not poll')}}};
 vm.createContext(context);vm.runInContext(code+';poll(win);report()',context);
 assert.equal(stops,1);assert.equal(ignored,false);
 assert.equal(JSON.stringify(actual),'[{"x":0,"y":80,"width":17,"height":20}]');
 context.payload.rects=[];vm.runInContext('report()',context);
 assert.equal(JSON.stringify(actual),'[{"x":0,"y":0,"width":1,"height":1}]');
 assert.equal(spawnSync(process.execPath,[script,file]).status,0);
 assert.equal(fs.readFileSync(file,'utf8'),code);
});

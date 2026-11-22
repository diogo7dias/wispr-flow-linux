const {test}=require('node:test');
const assert=require('node:assert/strict');
const {audioSummary}=require('../scripts/private-diagnostics.cjs');
test('audio report excludes identifying names, properties and monitor sources',()=>{
  const result=audioSummary(JSON.stringify([
    {name:'PRIVATE DEVICE',properties:{secret:'DO NOT EMIT'},monitor_of_sink:null,mute:false},
    {monitor_of_sink:0,mute:false}, {monitor_of_sink:null,mute:true}]));
  assert.deepEqual(result,{available:true,microphones:2,unmuted:1});
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('unavailable or invalid audio service returns only a status',()=>{
  for(const input of [null,'invalid','{}']) assert.deepEqual(audioSummary(input),{available:false});
});

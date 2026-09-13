import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveAudioClock} from '../src/live-audio-clock.mjs';
test('CT200 cadence preserves arbitrary chunk boundaries and pads only missing input',()=>{
  const clock=new LiveAudioClock(()=>{}),input=Buffer.alloc(1200);for(let i=0;i<input.length;i++)input[i]=i%251;
  clock.append(input.subarray(0,73));clock.append(input.subarray(73));const a=clock.frame(),b=clock.frame();assert.deepEqual(a,input.subarray(0,960));assert.deepEqual(b.subarray(0,240),input.subarray(960));assert(b.subarray(240).every(v=>v===0));assert.equal(clock.bytes,0);
  assert.throws(()=>clock.append(Buffer.alloc(480001)),{code:'VOICE_INPUT_QUEUE_LIMIT'});clock.stop();
});

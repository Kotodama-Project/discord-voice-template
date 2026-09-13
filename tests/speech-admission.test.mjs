import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechAdmission} from '../src/speech-admission.mjs';
test('silence and isolated transients do not admit a conversation',()=>{
  const gate=new SpeechAdmission(),quiet=Buffer.alloc(960),voice=Buffer.alloc(960);
  for(let i=0;i<voice.length;i+=2)voice.writeInt16LE(1000,i);
  for(let i=0;i<100;i++)assert.equal(gate.push(quiet),false);
  assert.equal(gate.push(voice),false);
  for(let i=0;i<20;i++)assert.equal(gate.push(quiet),false);
  for(let i=0;i<24;i++)assert.equal(gate.push(voice),false);
  assert.equal(gate.push(voice),true);
});

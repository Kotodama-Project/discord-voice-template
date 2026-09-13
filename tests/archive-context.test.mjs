import test from 'node:test';
import assert from 'node:assert/strict';
import {Pipeline} from '../src/pipeline.mjs';
test('completed archive context replaces duplicate fast transcripts without deleting evidence',()=>{
  const make=(key,metadata)=>({key,guildId:'g',channelId:'c',actorId:'a',revision:1,text:key,metadata});
  const sources=[make('fast',{archiveSessionRefs:['one']}),make('partial',{archiveSessionRefs:['one','two']}),make('archive',{kind:'archived_voice',sessionId:'one'})];
  const pipeline=new Pipeline({config:{analyzer:{}},store:{sources:()=>sources}});
  assert.deepEqual(new Set(pipeline.context({key:'new',guildId:'g',channelId:'c'},'a').map(s=>s.key)),new Set(['partial','archive']));assert.equal(sources.length,3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Pipeline} from '../src/pipeline.mjs';
test('background transcription cannot issue a second native conversation end',async()=>{
  let actions=0;const source={provider:'discord',key:'s',guildId:'g',channelId:'c',sourceId:'one',actorId:'a',readers:['a'],revision:1,final:true,text:'おしまい',metadata:{kind:'voice',nativeConversation:true}};
  const store={ingest:()=>({key:'s',state:'created'}),source:()=>source,sources:()=>[],tasks:()=>[],saveIntents:()=>[]};
  const pipeline=new Pipeline({store,config:{analyzer:{},discord:{operators:['a']},worker:{actions:[]}},analyzer:{analyze:async()=>({summary:'終了',intents:[],replyRequested:false,reply:'',voiceAction:'end_conversation'})},onVoiceAction:async()=>actions++});
  await pipeline.ingest(source,{reply:false});assert.equal(actions,0);
  source.metadata.nativeConversation=false;await pipeline.ingest(source,{reply:false});assert.equal(actions,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {Pipeline} from '../src/pipeline.mjs';
import {DiscordAdapter} from '../src/discord.mjs';
import {exampleConfig} from '../src/config.mjs';
import {voiceNotice} from '../src/consent.mjs';
import {transcriptMessages} from '../src/transcript-display.mjs';

const actor='100000000000000002',reader='100000000000000004';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const analysis={summary:'発話',intents:[],replyRequested:false,reply:''};
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'ktdm-transcript-')),store=new Store(root),config=exampleConfig();config.discord.voiceChannelId='100000000000000005';
  const source=(extra={})=>({provider:'discord',guildId:config.discord.guildId,channelId:config.discord.voiceChannelId,sourceId:'utterance-1',actorId:actor,revision:1,readers:[actor,reader],text:'資料を作って',final:true,metadata:{kind:'voice',inputAccountId:actor,privacyNoticeId:voiceNotice(config).id,createdAt:'2026-01-01T00:00:00.000Z'},...extra});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return {store,config,source};
}

test('utterance delivery preserves speaker, original text and each revision without broad channel posting',async t=>{
  const {store,config,source}=await fixture(t),sent=[],adapter=new DiscordAdapter({store,config,pipeline:{}});t.after(()=>adapter.client.destroy());
  adapter.verifiedInstallation=true;adapter.voice={allowed:()=>true};adapter.canRead=async()=>true;adapter.client.channels.fetch=async()=>({id:config.discord.voiceChannelId});adapter.client.users.fetch=async actor=>({send:async payload=>{sent.push({actor,payload});return {id:String(sent.length)};}});
  const first=source(),receipt=store.ingest(first),saved={...first,key:receipt.key};await adapter.transcript(saved,receipt);await adapter.transcript(saved,receipt);
  assert.equal(sent.length,2);assert.deepEqual(sent.map(item=>item.actor),[actor,reader]);assert(sent[0].payload.content.includes(`<@${actor}>`));assert(sent[0].payload.content.endsWith(first.text));assert.deepEqual(sent[0].payload.allowedMentions,{parse:[]});
  const correction=source({revision:2,text:'資料ではなく調査をして'}),revised=store.ingest(correction);await adapter.transcript({...correction,key:revised.key},revised);assert.equal(sent.length,4);assert(sent[2].payload.content.includes('文字起こしの訂正'));assert(sent[2].payload.content.includes('版 2'));
  assert.equal(JSON.parse(store.db.prepare('SELECT body FROM source_versions WHERE key=? AND revision=1').get(receipt.key).body).text,first.text);
});

test('transcript delivery rechecks reader access and consent after asynchronous lookups',async t=>{
  const {store,config,source}=await fixture(t),sent=[],errors=[];let allowed=true;
  const adapter=new DiscordAdapter({store,config,pipeline:{},onError:code=>errors.push(code)});t.after(()=>adapter.client.destroy());adapter.verifiedInstallation=true;adapter.voice={allowed:()=>allowed};adapter.canRead=async(_channel,id)=>id===actor;adapter.client.channels.fetch=async()=>({});adapter.client.users.fetch=async()=>{allowed=false;return {send:async value=>sent.push(value)};};
  const value=source(),receipt=store.ingest(value);await adapter.transcript({...value,key:receipt.key},receipt);assert.equal(sent.length,0);assert(errors.includes('SOURCE_ACCESS_DENIED'));assert.equal(store.db.prepare('SELECT count(*) AS n FROM deliveries').get().n,0);
});

test('failed transcript sends are not blindly replayed after adapter restart',async t=>{
  const {store,config,source}=await fixture(t);let sends=0;const value=source({readers:[actor]}),receipt=store.ingest(value);
  for(let restart=0;restart<2;restart++){
    const adapter=new DiscordAdapter({store,config,pipeline:{}});adapter.verifiedInstallation=true;adapter.voice={allowed:()=>true};adapter.canRead=async()=>true;adapter.client.channels.fetch=async()=>({});adapter.client.users.fetch=async()=>({send:async()=>{sends++;throw Error('fixture network uncertainty');}});
    await adapter.transcript({...value,key:receipt.key},receipt);adapter.client.destroy();
  }
  assert.equal(sends,1);
});

test('long transcript presentation preserves every character and labels tentative text',()=>{
  const text='発話😀'.repeat(1200),source={actorId:null,sourceId:'utterance-long',revision:2,text,final:false};const messages=transcriptMessages(source);
  assert(messages.every(m=>m.content.length<2000&&m.content.includes('暫定・実行しません')&&m.content.includes('話者未確定')));
  assert.equal(messages.map(m=>m.content.split('\n').slice(3).join('\n')).join(''),text);
});

test('saved voice sources display before analysis completes; provisional text never analyzes or executes',async t=>{
  const {store,config,source}=await fixture(t),display=[],calls=[];let release;
  const pipeline=new Pipeline({store,config,onSource:async s=>{assert.equal(store.source(s.key,actor).revision,s.revision);display.push(s.sourceId);},analyzer:{analyze:async s=>{calls.push(s.sourceId);await new Promise(resolve=>{release=resolve;});return analysis;}},worker:{}});
  await pipeline.ingest(source(),{execute:true},{waitForAnalysis:false});await tick();assert.equal(calls.length,1);
  await pipeline.ingest(source({sourceId:'partial',final:false}),{execute:true},{waitForAnalysis:false});assert.deepEqual(display,['utterance-1','partial']);assert.equal(calls.length,1);assert.equal(store.tasks(actor).length,0);
  release();await Promise.all([...pipeline.analysis.values()]);await pipeline.close();
});

test('rapid speech has one ordered analysis at a time, at most eight admitted turns, and all saved transcripts',async t=>{
  const {store,config,source}=await fixture(t),display=[],calls=[],errors=[];let release,active=0,maximum=0;
  const pipeline=new Pipeline({store,config,onSource:async s=>display.push(s.sourceId),onError:e=>errors.push(e),analyzer:{analyze:async s=>{calls.push(s.sourceId);maximum=Math.max(maximum,++active);if(calls.length===1)await new Promise(resolve=>{release=resolve;});active--;return analysis;}},worker:{}});
  const receipts=[];for(let i=0;i<10;i++)receipts.push(await pipeline.ingest(source({sourceId:`turn-${i}`}),{execute:false},{waitForAnalysis:false}));
  assert.equal(display.length,10);assert.equal(pipeline.voiceAnalysisPending,8);assert.equal(calls.length,1);assert.equal(receipts.filter(r=>r.analysis==='busy').length,2);assert.equal(errors.filter(e=>e==='VOICE_ANALYSIS_BUSY').length,2);
  release();await Promise.all([...pipeline.analysis.values()]);assert.deepEqual(calls,Array.from({length:8},(_,i)=>`turn-${i}`));assert.equal(maximum,1);assert.equal(pipeline.voiceAnalysisPending,0);await pipeline.close();
});

test('queued stale voice revisions never analyze and the same turn replay never schedules twice',async t=>{
  const {store,config,source}=await fixture(t),calls=[];let release;
  const pipeline=new Pipeline({store,config,analyzer:{analyze:async s=>{calls.push(`${s.sourceId}:${s.revision}`);if(s.sourceId==='blocking')await new Promise(resolve=>{release=resolve;});return analysis;}},worker:{}});
  await pipeline.ingest(source({sourceId:'blocking'}),{},{waitForAnalysis:false});await tick();
  await pipeline.ingest(source(),{},{waitForAnalysis:false});const correction=source({revision:2,text:'訂正です'});await pipeline.ingest(correction,{},{waitForAnalysis:false});await pipeline.ingest(correction,{},{waitForAnalysis:false});
  release();await Promise.allSettled([...pipeline.analysis.values()]);assert.deepEqual(calls,['blocking:1','utterance-1:2']);assert.equal(store.tasks(actor).length,0);await pipeline.close();
});

test('provisional sources remain saved but never enter analyzer or worker context until a final correction',async t=>{
  const {store,config,source}=await fixture(t);config.worker.actions=['write_file'];const contexts=[];
  const pipeline=new Pipeline({store,config,analyzer:{analyze:async(_source,context)=>{contexts.push(context);return {...analysis,intents:[{kind:'request',title:'資料',request:'資料を作って',action:'write_file',explicit:true,complete:true,acceptance:['資料がある']}]};}},worker:{run:async(_task,context)=>{contexts.push(context);return {state:'needs_review',summary:'synthetic',artifacts:[]};}}});
  const provisional=source({sourceId:'tentative',text:'まだ確定していない文',final:false});await pipeline.ingest(provisional,{execute:true});
  const current=source({sourceId:'confirmed-request'});await pipeline.ingest(current,{execute:true});await pipeline.tail;
  assert.equal(contexts.length,2);assert(contexts.every(context=>!context.some(item=>item.text===provisional.text)));const saved=store.sources(actor).find(item=>item.sourceId==='tentative');assert.equal(saved.final,false);assert.equal(saved.text,provisional.text);
  await pipeline.ingest({...provisional,revision:2,text:'確定した訂正文',final:true},{analyze:false});const nextContext=pipeline.context({...current,key:store.sources(actor).find(item=>item.sourceId==='confirmed-request').key},actor);assert(nextContext.some(item=>item.key===saved.key&&item.revision===2&&item.text==='確定した訂正文'));
  assert.equal(JSON.parse(store.db.prepare('SELECT body FROM source_versions WHERE key=? AND revision=1').get(saved.key).body).text,provisional.text);await pipeline.close();
});

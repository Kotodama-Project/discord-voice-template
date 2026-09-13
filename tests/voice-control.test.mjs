import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {VoiceConnectionStatus as State} from '@discordjs/voice';
import {Store} from '../src/store.mjs';
import {exampleConfig} from '../src/config.mjs';
import {VoiceRoom} from '../src/voice.mjs';
import {VoiceProvider} from '../src/voice-providers.mjs';
import {voiceCommand,voiceStatusText} from '../src/voice-control.mjs';

const a='100000000000000002',b='100000000000000004',outsider='100000000000000009';
class Connection extends EventEmitter {
  constructor(options,ready){super();this.options=options;this.state={status:ready?State.Ready:State.Connecting};this.subscriptions=0;this.destroyCount=0;this.receiver={speaking:new EventEmitter()};}
  subscribe(){this.subscriptions++;}
  transition(status){const old=this.state;this.state={status};this.emit('stateChange',old,this.state);this.emit(status);}
  destroy(){this.destroyCount++;this.transition(State.Destroyed);}
}
function waitForState(connection,status,signal){
  if(connection.state.status===status)return Promise.resolve(connection);
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{connection.off('stateChange',change);signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(new Error('wait cancelled'));};
    const change=(_old,state)=>{if(state.status===status){cleanup();resolve(connection);}};
    signal.addEventListener('abort',abort,{once:true});connection.on('stateChange',change);if(signal.aborted)abort();
  });
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{autoJoin=true,ready=true,wait=waitForState,fetchChannel,providerFactory}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'ktdm-occupancy-')),store=new Store(root),config=exampleConfig();
  config.discord.voiceChannelId='100000000000000005';Object.assign(config.voice,{autoJoin,maxDailyAudioSeconds:100,maxTotalAudioSeconds:100,participantIds:[a,b]});
  const channel={id:config.discord.voiceChannelId,guildId:config.discord.guildId,guild:{voiceAdapterCreator:{}},isVoiceBased:()=>true,members:new Map()};
  const client=new EventEmitter();client.channels={cache:new Map([[channel.id,channel]]),fetch:fetchChannel??(async()=>channel)};
  const connections=[],errors=[],sources=[];
  const room=new VoiceRoom({client,config,store,pipeline:{ingest:async(source,flags)=>sources.push({source,flags})},sourceReaders:async()=>[a,b],onError:code=>errors.push(code),waitForState:wait,
    connectionFactory:options=>{const connection=new Connection(options,ready);connections.push(connection);return connection;},
    providerFactory:providerFactory??(options=>({active:false,sessionId:'fixture-live',outputGeneration:0,start:async function(){this.active=true;},append(){},respond:async function(){return {outputGeneration:++this.outputGeneration};},interrupt(){},abort(){this.active=false;},close:async function(){options.onFragment({id:'last',text:'最後の発言',startMs:0,endMs:100});this.active=false;}}))});
  let clock=0;room.control.now=()=>clock;
  const member=(id,bot=false)=>channel.members.set(id,{id,user:{bot}});
  t.after(async()=>{await room.dispose();store.close();assert(path.basename(root).startsWith('ktdm-occupancy-'));await rm(root,{recursive:true,force:true});});
  return {root,store,config,room,channel,client,connections,errors,sources,member,advance:ms=>{clock+=ms;}};
}

test('autoJoin defaults off; empty rooms and bots do not connect or reserve audio',async t=>{
  assert.equal(exampleConfig().voice.autoJoin,false);
  const f=await fixture(t,{autoJoin:false});f.member(a);await f.room.control.check();assert.equal(f.connections.length,0);
  f.config.voice.autoJoin=true;f.channel.members.clear();await f.room.control.check();f.member(b,true);await f.room.control.check();
  assert.equal(f.connections.length,0);assert.equal(f.room.control.status().waiting,'empty');assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM usage').get().n,0);
});

function creditSdk(){
  const state={fail:true,failOnAppend:false,opened:[]};
  class Socket extends EventEmitter{
    constructor(){super();state.opened.push(this);this.socket=new EventEmitter();queueMicrotask(()=>this.socket.emit('open'));}
    send(event){
      if(event.type==='session.close'){queueMicrotask(()=>this.emit('event',{type:'session.closed'}));return;}
      if(event.type==='session.commentary.append'&&state.failOnAppend){queueMicrotask(()=>{const error={code:'credit_balance_exhausted',type:'invalid_request_error',message:'synthetic private diagnostic',client_event_id:event.event_id};this.emit('event',{type:'error',error,client_event_id:event.event_id});});return;}
      if(!['session.start','session.update'].includes(event.type))return;
      queueMicrotask(()=>{
        if(state.fail){const error={code:'credit_balance_exhausted',type:event.type==='session.start'?'invalid_request_error':'insufficient_quota',message:'synthetic private diagnostic'};this.emit('event',{type:'error',error});this.emit('error',Object.assign(new Error(error.message),{error}));}
        else this.emit('event',{type:event.type==='session.start'?'session.started':'session.updated',session:{id:'fixture'}});
      });
    }
    close(){this.closed=true;}
  }
  return {state,sdk:{OpenAI:class{},LiveWS:Socket,OpenAIRealtimeWS:Socket}};
}

for(const mode of ['assist','minutes'])test(`${mode} credit failure stops once and remains suspended across automatic checks, mode changes and restart`,async t=>{
  const {state,sdk}=creditSdk(),f=await fixture(t,{providerFactory:options=>new VoiceProvider({...options,sdk})});f.member(a);f.config.voice.apiKeyEnv='KOTODAMA_OCCUPANCY_TEST_KEY';process.env.KOTODAMA_OCCUPANCY_TEST_KEY='fixture';t.after(()=>delete process.env.KOTODAMA_OCCUPANCY_TEST_KEY);
  await f.room.setMode(mode);await f.room.control.check();const connection=f.connections[0];connection.receiver.speaking.emit('start',a);await flush();
  assert.deepEqual(f.errors,['VOICE_API_CREDITS_EXHAUSTED']);assert.equal(f.room.control.status().suspension,'provider_credit');assert.equal(f.room.control.status().waitingText,'音声APIの残高補充待ち');assert.equal(f.room.connection,null);assert.equal(f.room.paused,true);
  connection.receiver.speaking.emit('start',a);await f.room.capture(a);await f.room.control.check();await voiceCommand(f.room,mode==='assist'?'minutes':'assist');await f.room.control.check();assert.equal(state.opened.length,1);assert.equal(f.room.control.status().suspension,'provider_credit');assert.equal(f.store.db.prepare('SELECT SUM(reserved_ms) AS ms FROM usage').get().ms,1000);
  f.config.voice.maxTotalAudioSeconds=1;await assert.rejects(voiceCommand(f.room,'resume'),{code:'AUDIO_TOTAL_BUDGET_EXHAUSTED'});assert.equal(f.room.control.status().suspension,'provider_credit');f.config.voice.maxTotalAudioSeconds=100;
  const reopened=new Store(f.root),client=new EventEmitter();client.channels=f.client.channels;const room=new VoiceRoom({client,config:f.config,store:reopened,pipeline:{},connectionFactory:options=>new Connection(options,true),waitForState,providerFactory:options=>new VoiceProvider({...options,sdk})});
  try{await room.control.check();assert.equal(room.connection,null);assert.equal(room.control.status().suspension,'provider_credit');await room.capture(a);assert.equal(state.opened.length,1);state.fail=false;await voiceCommand(room,mode==='assist'?'resume':'join');const session=await room.session(a);assert.equal(session.provider.active,true);assert.equal(room.control.status().suspension,null);assert.equal(state.opened.length,2);}
  finally{await room.dispose();reopened.close();}
});

test('credit failure during reply also suspends voice without retrying playback',async t=>{
  const {state,sdk}=creditSdk();state.fail=false;const f=await fixture(t,{providerFactory:options=>new VoiceProvider({...options,sdk})});f.member(a);f.config.voice.apiKeyEnv='KOTODAMA_OCCUPANCY_TEST_KEY';process.env.KOTODAMA_OCCUPANCY_TEST_KEY='fixture';t.after(()=>delete process.env.KOTODAMA_OCCUPANCY_TEST_KEY);await f.room.control.check();await f.room.session(a);state.failOnAppend=true;
  const key=f.store.ingest({provider:'discord',guildId:f.config.discord.guildId,channelId:f.channel.id,sourceId:'reply-fixture',actorId:a,revision:1,final:true,readers:[a],text:'fixture',metadata:{}}).key;
  const options={epoch:f.room.epoch,actorId:a,bindings:[{key,revision:1}],authorizeAudience:async()=>[a]};await f.room.speak('回答',options);await flush();await f.room.speak('再試行しない',options);await f.room.control.check();
  assert.deepEqual(f.errors,['VOICE_API_CREDITS_EXHAUSTED']);assert.equal(f.room.control.status().suspension,'provider_credit');assert.equal(state.opened.length,1);assert.equal(f.room.reply,null);
});

test('a stale input provider or output generation cannot suspend its replacement',async t=>{
  const providers=[],f=await fixture(t,{providerFactory:options=>{const p={options,active:false,sessionId:'fixture-'+providers.length,outputGeneration:0,start:async function(){this.active=true;},append(){},respond:async function(){return {outputGeneration:++this.outputGeneration};},interrupt(){},abort(){this.active=false;},close:async function(){this.active=false;}};providers.push(p);return p;}});f.member(a);f.config.voice.apiKeyEnv='KOTODAMA_OCCUPANCY_TEST_KEY';process.env.KOTODAMA_OCCUPANCY_TEST_KEY='fixture';t.after(()=>delete process.env.KOTODAMA_OCCUPANCY_TEST_KEY);await f.room.control.check();
  const old=await f.room.session(a);await voiceCommand(f.room,'minutes');const current=await f.room.session(a);old.provider.options.onError('VOICE_API_CREDITS_EXHAUSTED');assert(f.room.current(current));assert.equal(f.room.control.status().suspension,null);assert.deepEqual(f.errors,[]);
  await voiceCommand(f.room,'assist');const key=f.store.ingest({provider:'discord',guildId:f.config.discord.guildId,channelId:f.channel.id,sourceId:'reply-fixture',actorId:a,revision:1,final:true,readers:[a],text:'fixture',metadata:{}}).key;
  const assist=await f.room.session(a),options={epoch:f.room.epoch,actorId:a,bindings:[{key,revision:1}],authorizeAudience:async()=>[a]};await f.room.speak('一つ目',options);const previous=f.room.reply;await f.room.speak('二つ目',options);const replacement=f.room.reply;previous.provider.options.onAudio(Buffer.alloc(2),previous.sessionId,previous.outputGeneration);
  assert.equal(previous.provider,replacement.provider);assert.notEqual(previous.outputGeneration,replacement.outputGeneration);assert.equal(f.room.reply,replacement);assert.equal(assist.provider.active,true);assert.equal(f.room.control.status().suspension,null);assert.deepEqual(f.errors,[]);
});

test('startup and event bursts join one configured lounge; another VC never becomes a target',async t=>{
  const f=await fixture(t,{ready:false});f.member(a);f.room.control.start();await flush();
  for(let n=0;n<20;n++)f.client.emit('voiceStateUpdate',{guild:{id:f.config.discord.guildId},channelId:null},{guild:{id:f.config.discord.guildId},channelId:f.channel.id});
  assert.equal(f.connections.length,1);f.connections[0].transition(State.Ready);await f.room.control.check();
  assert.equal(f.connections.length,1);assert.equal(f.connections[0].options.channelId,f.channel.id);assert.equal(f.connections[0].subscriptions,1);
  f.client.emit('voiceStateUpdate',null,{guild:{id:f.config.discord.guildId},channelId:'100000000000000008'});await flush();assert.equal(f.connections.length,1);
});

test('status reports Ready only after joining completes, and never reports disconnected as connected',async t=>{
  const f=await fixture(t,{ready:false});f.member(a);const joining=f.room.control.check();await flush();
  assert.equal(f.connections[0].state.status,State.Connecting);assert.equal(f.room.control.status().connected,false);assert.equal(f.room.control.status().waiting,'joining');assert(!voiceStatusText(f.room.control.status()).includes('接続済み'));
  f.connections[0].transition(State.Ready);assert.equal(f.room.control.status().connected,false);assert.equal(f.room.control.status().waiting,'joining');await joining;
  assert.equal(f.room.control.status().connected,true);assert.equal(f.room.control.status().waiting,'connected');
  f.connections[0].transition(State.Disconnected);assert.equal(f.room.control.status().connected,false);assert.equal(f.room.control.status().waiting,'recovering');
});

test('all humans must be scoped and explicit opt-out prevents capture and reconnect',async t=>{
  const f=await fixture(t);f.member(a);f.member(outsider);await f.room.control.check();assert.equal(f.connections.length,0);
  f.channel.members.delete(outsider);await f.room.control.check();assert.equal(f.connections.length,1);
  f.member(outsider);await f.room.capture(a);assert.equal(f.room.sessions.size,0);await f.room.control.check();assert.equal(f.room.connection,null);
  f.channel.members.delete(outsider);f.store.recordConsent({guild:f.config.discord.guildId,channel:f.channel.id,actor:a,notice:'fixture',granted:false,interactionId:'900000000000000010'});
  await f.room.control.check();assert.equal(f.connections.length,1);assert.equal(f.room.control.status().waiting,'scope');
});

test('a return cancels empty grace; the next check after 15 seconds drains and leaves',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();
  f.channel.members.clear();await f.room.control.check();assert.equal(f.room.control.status().waiting,'empty_grace');f.advance(10000);await f.room.control.check();assert(f.room.connection);
  f.member(a);await f.room.control.check();f.advance(10000);f.channel.members.clear();await f.room.control.check();assert(f.room.connection);
  f.advance(14999);await f.room.control.check();assert(f.room.connection);f.advance(1);await f.room.control.check();assert.equal(f.room.connection,null);assert.equal(f.connections[0].destroyCount,1);
  f.member(a);await f.room.control.check();assert.equal(f.connections.length,2);assert.equal(f.room.paused,false);
});

for(const mode of ['pause','leave'])test(`${mode} during a pending join cannot attach later, and mode switches preserve suspension`,async t=>{
  const f=await fixture(t,{ready:false});f.member(a);const pending=f.room.control.check();await flush();const connection=f.connections[0];
  await voiceCommand(f.room,mode);connection.transition(State.Ready);await pending;await voiceCommand(f.room,'minutes');await f.room.control.check();
  assert.equal(connection.subscriptions,0);assert.equal(f.room.connection,null);assert.equal(f.room.paused,true);assert.equal(f.room.control.status().suspension,mode);assert.equal(f.connections.length,1);
});

test('leave during channel fetch prevents construction; a late old join cannot destroy a replacement',async t=>{
  let resolveFetch;const f=await fixture(t,{fetchChannel:()=>new Promise(resolve=>{resolveFetch=resolve;})});f.member(a);const pending=f.room.control.check();await flush();
  await voiceCommand(f.room,'leave');resolveFetch(f.channel);await pending;assert.equal(f.connections.length,0);
  // An injected wait ignoring cancellation models a late third-party completion.
  const waits=[];f.room.waitForState=()=>new Promise((resolve,reject)=>waits.push({resolve,reject}));f.client.channels.fetch=async()=>f.channel;
  const old=voiceCommand(f.room,'join');const rejected=assert.rejects(old,/late old failure/);await flush();const oldConnection=f.connections[0];await voiceCommand(f.room,'leave');
  const next=voiceCommand(f.room,'join');await flush();const replacement=f.connections[1];waits[1].resolve();await next;waits[0].reject(new Error('late old failure'));await rejected;
  assert.equal(f.room.connection,replacement);assert.equal(replacement.destroyCount,0);assert.equal(oldConnection.subscriptions,0);
});

test('scope revocation and shutdown invalidate a pending join before provider attachment',async t=>{
  const f=await fixture(t,{ready:false});f.member(a);const pending=f.room.control.check();await flush();f.config.voice.participantIds=[];f.connections[0].transition(State.Ready);await pending;
  assert.equal(f.connections[0].subscriptions,0);assert.equal(f.room.connection,null);
  f.config.voice.participantIds=[a];const next=f.room.control.check();await flush();await f.room.control.stop();await next;assert.equal(f.connections[1].subscriptions,0);
});

test('changing the configured guild or channel closes the original target without following',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();f.config.discord.voiceChannelId='100000000000000008';await f.room.control.check();
  assert.equal(f.room.connection,null);assert.equal(f.connections.length,1);assert.equal(f.room.control.status().waiting,'scope');await assert.rejects(voiceCommand(f.room,'join'),/VOICE_TARGET_MISMATCH/);
});

test('disconnect gets a Ready recovery grace, and failed recovery permits a later occupancy join',async t=>{
  let failRecovery;const f=await fixture(t,{wait:(connection,status,signal)=>connection.state.status===State.Ready?Promise.resolve():new Promise((resolve,reject)=>{failRecovery=reject;waitForState(connection,status,signal).then(resolve,reject);})});
  f.member(a);await f.room.control.check();const first=f.connections[0];first.transition(State.Disconnected);assert(f.room.recovering);assert.equal(f.room.control.status().waiting,'recovering');
  first.transition(State.Signalling);first.transition(State.Connecting);first.transition(State.Ready);await flush();assert.equal(f.room.recovering,null);assert.equal(f.room.connection,first);
  first.transition(State.Disconnected);failRecovery(new Error('grace expired'));await flush();assert.equal(f.room.connection,null);await f.room.control.check();assert.equal(f.connections.length,2);
});

test('manual pause during recovery is not undone when Ready arrives',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();f.connections[0].transition(State.Disconnected);await voiceCommand(f.room,'pause');f.connections[0].transition(State.Ready);await flush();await f.room.control.check();
  assert.equal(f.room.paused,true);assert.equal(f.room.control.status().suspension,'pause');
});

test('a destroyed active connection drains and rejoins, while a stale Destroyed event cannot close its replacement',async t=>{
  const f=await fixture(t);f.member(a);f.config.voice.apiKeyEnv='KOTODAMA_OCCUPANCY_TEST_KEY';process.env.KOTODAMA_OCCUPANCY_TEST_KEY='fixture';t.after(()=>delete process.env.KOTODAMA_OCCUPANCY_TEST_KEY);
  await f.room.control.check();const first=f.connections[0],session=await f.room.session(a);session.turns.end(session.turns.begin(0),100);assert(f.room.current(session));
  first.transition(State.Destroyed);assert.equal(f.room.current(session),false);assert.equal(f.room.control.status().connected,false);await flush();
  assert.equal(f.room.connection,null);assert.equal(session.provider.active,false);assert.equal(f.sources.length,1);assert.deepEqual(f.sources[0].flags,{execute:false,reply:false,analyze:false});
  await f.room.control.check();const replacement=f.connections[1];assert.equal(f.room.connection,replacement);first.emit(State.Destroyed);await flush();assert.equal(f.room.connection,replacement);assert.equal(replacement.destroyCount,0);
});

test('Destroyed during a pending join invalidates the attempt without waiting for Ready',async t=>{
  const f=await fixture(t,{ready:false});f.member(a);const pending=f.room.control.check();await flush();f.connections[0].transition(State.Destroyed);assert.equal(f.room.joining,null);await pending;
  assert.equal(f.room.connection,null);assert.equal(f.connections[0].subscriptions,0);assert.equal(f.room.control.status().connected,false);
});

test('an explicit join after automatic leave replaces old automatic ownership',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();await voiceCommand(f.room,'leave');f.config.voice.autoJoin=false;await voiceCommand(f.room,'join');const manual=f.room.connection;
  await f.room.control.check();assert.equal(f.room.connection,manual);assert.equal(manual.destroyCount,0);assert.equal(f.room.control.status().connected,true);
});

test('an explicit resume of an automatic connection survives disabling autoJoin',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();await voiceCommand(f.room,'pause');f.config.voice.autoJoin=false;await voiceCommand(f.room,'resume');const manual=f.room.connection;
  await f.room.control.check();assert.equal(f.room.connection,manual);assert.equal(manual.destroyCount,0);assert.equal(f.room.paused,false);
});

test('a newer resume wins over an unfinished mode switch from manual pause',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();await voiceCommand(f.room,'pause');
  const mode=voiceCommand(f.room,'minutes'),resume=voiceCommand(f.room,'resume');await Promise.all([mode,resume]);
  assert.equal(f.room.mode,'minutes');assert.equal(f.room.control.status().suspension,null);assert.equal(f.room.paused,false);
});

test('overlapping mode switches preserve the final mode and the original recording state',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();await Promise.all([voiceCommand(f.room,'minutes'),voiceCommand(f.room,'assist')]);
  assert.equal(f.room.mode,'assist');assert.equal(f.room.paused,false);assert.equal(f.room.control.status().suspension,null);
});

for(const stop of ['pause','leave'])test(`a newer ${stop} keeps an unfinished mode switch stopped`,async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();const mode=voiceCommand(f.room,'minutes'),stopped=voiceCommand(f.room,stop);await Promise.all([mode,stopped]);
  assert.equal(f.room.mode,'minutes');assert.equal(f.room.paused,true);assert.equal(f.room.control.status().suspension,stop);await f.room.control.check();assert.equal(f.connections.length,1);
});

test('persisted manual pause survives store reopen and explicit resume re-enables automatic entry',async t=>{
  const f=await fixture(t);f.member(a);await voiceCommand(f.room,'pause');
  const reopened=new Store(f.root);const client=new EventEmitter();client.channels=f.client.channels;
  const room=new VoiceRoom({client,config:f.config,store:reopened,pipeline:{},connectionFactory:options=>new Connection(options,true),waitForState});
  try{await room.control.check();assert.equal(room.connection,null);assert.equal(room.paused,true);assert(voiceStatusText(room.control.status()).includes('録音停止中'));await voiceCommand(room,'resume');assert(room.connection);assert.equal(reopened.voiceSuspension(f.config.discord.guildId,f.channel.id),null);}
  finally{await room.dispose();reopened.close();}
});

test('budget exhaustion persists suspension and never spends another reservation automatically',async t=>{
  const f=await fixture(t);f.config.voice.maxTotalAudioSeconds=1;f.member(a);await f.room.control.check();f.store.reserveAudio(1000,100,undefined,1);await f.room.control.check();
  assert.equal(f.room.connection,null);assert.equal(f.room.control.status().suspension,'budget');f.config.voice.maxTotalAudioSeconds=10;await f.room.control.check();assert.equal(f.connections.length,1);
  assert.equal(f.store.db.prepare('SELECT SUM(reserved_ms) AS ms FROM usage').get().ms,1000);await voiceCommand(f.room,'resume');assert.equal(f.connections.length,2);
});

test('an occupancy exit drains old source text but disables execution and speech for the old epoch',async t=>{
  const f=await fixture(t);f.member(a);f.config.voice.apiKeyEnv='KOTODAMA_OCCUPANCY_TEST_KEY';process.env.KOTODAMA_OCCUPANCY_TEST_KEY='fixture';t.after(()=>delete process.env.KOTODAMA_OCCUPANCY_TEST_KEY);
  await f.room.control.check();const session=await f.room.session(a);session.turns.end(session.turns.begin(0),100);const epoch=session.epoch;f.channel.members.clear();await f.room.control.check();f.advance(20000);await f.room.control.check();
  assert.equal(f.sources.length,1);assert.equal(f.sources[0].source.text,'最後の発言');assert.equal(f.sources[0].source.metadata.voiceEpoch,epoch);assert.deepEqual(f.sources[0].flags,{execute:false,reply:false,analyze:false});assert(f.room.epoch>epoch);assert.equal(session.provider.active,false);
});

test('leaving disconnects promptly while already sealed transcription finishes',async t=>{
  const f=await fixture(t);f.member(a);f.config.voice.apiKeyEnv='KOTODAMA_OCCUPANCY_TEST_KEY';process.env.KOTODAMA_OCCUPANCY_TEST_KEY='fixture';t.after(()=>delete process.env.KOTODAMA_OCCUPANCY_TEST_KEY);
  await f.room.control.check();const session=await f.room.session(a);session.turns.end(session.turns.begin(0),100);
  let finishDrain;const originalClose=session.provider.close.bind(session.provider);session.provider.close=async()=>{await new Promise(resolve=>{finishDrain=resolve;});await originalClose();};
  const draining=f.room.endSession(session);assert.equal(f.room.sessions.size,0);const closing=voiceCommand(f.room,'leave');await flush();const disconnectedBeforeDrain=f.connections[0].destroyCount;
  finishDrain();await draining;await closing;assert.equal(disconnectedBeforeDrain,1);assert.equal(f.sources.length,1);assert.equal(f.connections[0].destroyCount,1);assert.equal(f.sources[0].flags.execute,false);
});

test('explicit conversation start bypasses wake transcription, retains scope and supports end',async t=>{
  const f=await fixture(t);f.member(a);f.config.voice.apiKeyEnv='KOTODAMA_OCCUPANCY_TEST_KEY';process.env.KOTODAMA_OCCUPANCY_TEST_KEY='fixture';t.after(()=>delete process.env.KOTODAMA_OCCUPANCY_TEST_KEY);
  await f.room.control.check();await assert.rejects(f.room.control.command('start_conversation',{actor:'outsider'}),{code:'VOICE_CONVERSATION_ACTOR_REQUIRED'});
  await f.room.control.command('start_conversation',{actor:a});const first=f.room.sessions.get(a);assert(first.conversationActive);assert(first.provider.active);
  await f.room.control.command('start_conversation',{actor:a});assert.equal(f.room.sessions.get(a),first);
  await f.room.control.command('end_conversation',{actor:a});assert.equal(f.room.sessions.size,0);
});

test('an active room refuses reassignment to another VM, agent, or workspace',async t=>{
  const f=await fixture(t);f.member(a);await f.room.control.check();assert(f.room.connectionReady());
  f.config.agentBinding={agentId:'different-agent',vmId:'vm-other'};await f.room.control.check();assert.equal(f.room.connection,null);assert.equal(f.room.control.state,'scope');
  delete f.config.agentBinding;await f.room.control.check();assert(f.room.connectionReady());
  f.config.worker.workspace+='-other';await f.room.control.check();assert.equal(f.room.connection,null);
});

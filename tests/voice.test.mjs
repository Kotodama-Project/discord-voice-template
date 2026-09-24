import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {VoiceProvider} from '../src/voice-providers.mjs';

class Client{constructor() {}}
class Live extends EventEmitter{
  constructor(){super();this.sent=[];Live.last=this;}
  send(e){this.sent.push(e);if(e.type==='session.start')queueMicrotask(()=>this.emit('event',{type:'session.started',session:{id:'live-test',model:e.session.model}}));if(e.type==='session.close')queueMicrotask(()=>this.emit('event',{type:'session.closed'}));}
  close(){this.didClose=true;}
}
class Transcription extends EventEmitter{
  constructor(){super();this.sent=[];this.socket=new EventEmitter();Transcription.last=this;queueMicrotask(()=>this.socket.emit('open'));}
  send(e){this.sent.push(e);if(e.type==='session.update')queueMicrotask(()=>this.emit('event',{type:'session.updated',session:{id:'transcription-test'}}));}
  close(){this.didClose=true;}
}
const sdk={OpenAI:Client,LiveWS:Live,OpenAIRealtimeWS:Transcription};
test('assist uses actual Live protocol, emits input text, and discards all unsolicited audio',async()=>{
  const text=[],audio=[];const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk,onFragment:f=>text.push(f),onAudio:a=>audio.push(a)});await p.start();assert.equal(Live.last.sent[0].type,'session.start');assert.equal(Live.last.sent[0].session.model,'gpt-live-1');assert.equal(Live.last.sent[0].session.store,false);
  Live.last.emit('event',{type:'session.input_transcript.delta',event_id:'t',delta:'こんにちは',start_ms:0,end_ms:100});Live.last.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(4).toString('base64')});assert.equal(text.length,1);assert.equal(audio.length,0);await p.close();assert(Live.last.didClose);
});
test('minutes uses transcription-only session with local VAD commit and no response creation',async()=>{
  const audio=[],completed=[];const p=new VoiceProvider({mode:'minutes',apiKey:'synthetic-test',sdk,onAudio:a=>audio.push(a),onCompleted:t=>completed.push(t)});await p.start();const ws=Transcription.last;assert.equal(ws.sent[0].session.type,'transcription');assert.equal(ws.sent[0].session.audio.input.transcription.model,'gpt-live-transcribe');assert.equal(ws.sent[0].session.audio.input.turn_detection,null);
  p.append(Buffer.alloc(4800));p.commit({id:'turn-1'});ws.emit('event',{type:'input_audio_buffer.committed',item_id:'item-1'});ws.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(4).toString('base64')});ws.emit('event',{type:'conversation.item.input_audio_transcription.completed',item_id:'item-1',transcript:'資料を作る'});assert.equal(audio.length,0);assert.equal(completed[0].id,'turn-1');assert(!ws.sent.some(e=>e.type==='response.create'));await p.close();
});
test('out-of-order transcription completions keep their original utterance identities',async()=>{
  const completed=[];const p=new VoiceProvider({mode:'minutes',apiKey:'synthetic-test',sdk,onCompleted:t=>completed.push(t)});await p.start();p.commit({id:'turn-a'});p.commit({id:'turn-b'});const ws=Transcription.last;ws.emit('event',{type:'input_audio_buffer.committed',item_id:'a'});ws.emit('event',{type:'input_audio_buffer.committed',item_id:'b'});ws.emit('event',{type:'conversation.item.input_audio_transcription.completed',item_id:'b',transcript:'二番'});ws.emit('event',{type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'一番'});assert.deepEqual(completed.map(t=>t.id),['turn-b','turn-a']);await p.close();
});
test('assist speaks backend results in the same Live session and can be interrupted without closing it',async()=>{
  const audio=[];const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk,onAudio:(chunk,id,generation)=>audio.push({chunk,id,generation})});await p.start();const ws=Live.last;
  const first=await p.respond('調べた結果です。');assert.equal(ws.sent.filter(e=>e.type==='session.start').length,1);assert.equal(ws.sent.at(-1).type,'session.commentary.append');assert.equal(ws.sent.at(-1).delegation_id,null);
  ws.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(4).toString('base64')});assert.equal(audio.length,1);assert.equal(audio[0].generation,first.outputGeneration);
  p.interrupt();assert.equal(ws.sent.at(-1).type,'session.instructions.append');assert.equal(p.active,true);assert.equal(ws.sent.some(e=>e.type==='session.close'),false);
  await p.close();ws.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(4).toString('base64')});assert.equal(audio.length,1);
});
test('Live usage snapshots replace prior duration and retain the final close value',async()=>{const usage=[];const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk,onUsage:value=>usage.push(value)});await p.start();Live.last.emit('event',{type:'session.usage.updated',usage:{seconds:5},context_window:{usage_ratio:0.2}});const closing=p.close();Live.last.emit('event',{type:'session.closed',usage:{seconds:7},context_window:{usage_ratio:0.3}});await closing;assert.deepEqual(usage,[{seconds:5,contextUsageRatio:0.2,final:false},{seconds:7,contextUsageRatio:0.3,final:true}]);});
test('closing an unopened Live connection settles its pending start immediately',async()=>{class Pending extends Live{send(e){this.sent.push(e);}}const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk:{...sdk,LiveWS:Pending}});const start=p.start();const rejected=assert.rejects(start,/VOICE_START_CANCELLED/);await p.close();await rejected;assert.equal(p.active,false);assert(Live.last.didClose);});

for(const mode of ['assist','minutes'])for(const first of ['event','wrapper'])test(`${mode} classifies credit exhaustion once when ${first} arrives first`,async()=>{
  const raw={type:mode==='assist'?'invalid_request_error':'insufficient_quota',code:'credit_balance_exhausted',message:'synthetic private diagnostic'},notifications=[];
  const fail=transport=>queueMicrotask(()=>{
    const event={type:'error',error:raw},wrapper=Object.assign(new Error(raw.message),{error:raw});
    for(const kind of [first,first==='event'?'wrapper':'event'])transport.emit(kind==='event'?'event':'error',kind==='event'?event:wrapper);
    transport.emit('close');transport.socket?.emit('close');
  });
  class FailedLive extends Live{send(e){this.sent.push(e);if(e.type==='session.start')fail(this);}}
  class FailedTranscription extends Transcription{send(e){this.sent.push(e);if(e.type==='session.update')fail(this);}}
  const p=new VoiceProvider({mode,apiKey:'synthetic-test',sdk:{...sdk,LiveWS:FailedLive,OpenAIRealtimeWS:FailedTranscription},onError:code=>notifications.push(code)});
  await assert.rejects(p.start(),error=>error.name==='Refused'&&error.code==='VOICE_API_CREDITS_EXHAUSTED'&&error.message==='VOICE_API_CREDITS_EXHAUSTED');
  assert.deepEqual(notifications,['VOICE_API_CREDITS_EXHAUSTED']);assert.equal(p.active,false);assert.equal(p.closed,true);assert(!JSON.stringify(notifications).includes(raw.message));
});

test('a generic provider failure is preserved through abort and is notified only once',async()=>{
  const notifications=[];class Failed extends Live{send(){queueMicrotask(()=>{this.emit('error',new Error('synthetic private transport error'));this.emit('error',new Error('again'));});}}
  const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk:{...sdk,LiveWS:Failed},onError:code=>notifications.push(code)});
  await assert.rejects(p.start(),{code:'VOICE_PROVIDER_FAILED',message:'VOICE_PROVIDER_FAILED'});assert.deepEqual(notifications,['VOICE_PROVIDER_FAILED']);
});

test('late errors after deliberate abort do not notify a former session',async()=>{
  const notifications=[],p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk,onError:code=>notifications.push(code)});await p.start();p.abort();
  Live.last.emit('error',{error:{code:'credit_balance_exhausted'}});Live.last.emit('event',{type:'error',error:{code:'credit_balance_exhausted'}});assert.deepEqual(notifications,[]);
});

test('a synchronous SDK failure is classified without exposing its diagnostic',async()=>{
  const notifications=[];class Failed{constructor(){throw new Error('synthetic private diagnostic');}}
  const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk:{...sdk,LiveWS:Failed},onError:code=>notifications.push(code)});
  await assert.rejects(p.start(),{code:'VOICE_PROVIDER_FAILED',message:'VOICE_PROVIDER_FAILED'});assert.deepEqual(notifications,['VOICE_PROVIDER_FAILED']);
});

test('natural frontend speaks without waiting for a local transcript result',async()=>{
  const audio=[];let parked=0;const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk,naturalConversation:true,onAudio:b=>audio.push(b),onPark:()=>parked++});await p.start();
  const session=Live.last.sent[0].session;assert.equal(session.delegation.type,'responses');assert.equal(session.delegation.responses.model,'gpt-5.6-luna');assert.equal(session.delegation.responses.max_output_tokens,800);
  Live.last.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')});assert.equal(audio.length,1);
  const item={type:'function_call',call_id:'park',name:'park_voice_conversation',arguments:'{}'};
  Live.last.emit('event',{type:'response.event',event:{type:'response.created',response:{id:'r'}}});
  Live.last.emit('event',{type:'response.event',event:{type:'response.output_item.done',item}});
  Live.last.emit('event',{type:'response.event',event:{type:'response.completed',response:{id:'r',output:[]}}});
  assert.equal(parked,1);await p.close();
});

test('native status uses the scoped backend and continues only after its result',async()=>{
  let reads=0;const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk,naturalConversation:true,onStatus:async()=>{reads++;return {scope:'current_installation',connected:true};}});await p.start();
  await p.handleNativeCalls([{name:'get_agent_status',call_id:'s',arguments:'{ }'}]);assert.equal(reads,1);
  const events=Live.last.sent.slice(-2);assert.equal(events[0].type,'response.item.create');assert.equal(JSON.parse(events[0].item.output).scope,'current_installation');assert.equal(events[1].type,'response.create');
  await assert.rejects(p.handleNativeCalls([{name:'get_agent_status',call_id:'other',arguments:'{"vm":"other"}'}]),{code:'LIVE_TOOL_ARGUMENTS_INVALID'});assert.equal(reads,1);await p.close();
});

test('natural conversation can speak again on the next input after a manual interruption',async()=>{
  const output=[];const p=new VoiceProvider({mode:'assist',apiKey:'synthetic-test',sdk,naturalConversation:true,onAudio:b=>output.push(b)});await p.start();p.interrupt();Live.last.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')});assert.equal(output.length,0);
  Live.last.emit('event',{type:'session.input_transcript.delta',event_id:'next-turn',delta:'続けて',start_ms:100,end_ms:200});Live.last.emit('event',{type:'session.output_audio.delta',delta:Buffer.alloc(960).toString('base64')});assert.equal(output.length,1);await p.close();
});

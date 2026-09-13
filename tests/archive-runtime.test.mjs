import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ArchiveRuntime} from '../src/archive-runtime.mjs';
import {createLunaArchiveCorrector} from '../src/archive-host.mjs';
import {Store} from '../src/store.mjs';

async function setup(t){const root=await mkdtemp(path.join(os.tmpdir(),'archive-runtime-'));await mkdir(path.join(root,'recordings'));const store=new Store(path.join(root,'data'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});const actor='100000000000003';let now=Date.now();const config={owner:{kind:'local'},installation:'fixture-install',agentBinding:{agentId:'fixture-agent',vmId:'fixture-vm'},dataDir:path.join(root,'data'),worker:{workspace:root},discord:{guildId:'100000000000001',voiceChannelId:'100000000000002',operators:[actor]},voice:{participantIds:[actor]},analyzer:{kind:'responses',model:'gpt-5.6-luna',apiKeyEnv:'FIXTURE_API_KEY',maxOutputTokens:512},archive:{enabled:true,archiveRoot:path.join(root,'recordings'),journalPath:path.join(root,'queue.sqlite'),retentionPolicyRef:'retention-fixture',sourceRef:'source-fixture',actorId:actor,readers:[actor],whisperEndpoint:'http://127.0.0.1:1/transcribe',canProcess:false,batchMs:250,rotationMs:55000,maxPendingSessions:2}};
  return {config,store,actor,clock:()=>now,advance:n=>{now+=n;},root};}
test('Responses corrector is strict low effort bounded output, no storage or secret disclosure; blank raw skips model',async()=>{
  let options,body,calls=0;class Client{constructor(x){options=x;this.responses={create:async x=>{calls++;body=x;return {status:'completed',output_text:'{"edits":[]}',usage:{input_tokens:10,output_tokens:5}};}};}}
  const fn=createLunaArchiveCorrector({command:{kind:'responses',model:'gpt-5.6-luna',apiKeyEnv:'FIXTURE_KEY',maxOutputTokens:512},sdk:{OpenAI:Client},readEnv:k=>k==='FIXTURE_KEY'?'synthetic':null,authorize:()=>true});
  assert.deepEqual(await fn({raw:{individual:[],mixed:[]},binding:{}}),[]);assert.equal(calls,0);
  await fn({raw:{individual:[{speaker_id:'a',idx:0,start:0,end:1,text:'原文',confidence:1}],mixed:[]},binding:{}});
  assert.equal(options.apiKey,'synthetic');assert.equal(options.maxRetries,0);assert.equal(body.store,false);assert.equal(body.reasoning.effort,'low');assert.equal(body.max_output_tokens,512);assert.equal(body.text.format.strict,true);assert.equal(body.truncation,'disabled');assert(!JSON.stringify(body).includes('synthetic'));
});
test('250ms batching retains final packet on stop; silence does not start a session',async t=>{
  const f=await setup(t),r=new ArchiveRuntime({...f,authorize:()=>true,analyzer:{}});try{
    const pcm=Buffer.alloc(1920);assert.deepEqual(r.append(f.actor,pcm,f.clock()),{ignoredSilence:true});assert.equal(r.current,null);pcm.writeInt16LE(10,0);
    for(let i=0;i<10;i++){r.append(f.actor,pcm,f.clock());f.advance(20);}
    assert.equal(r.adapter.db.prepare('SELECT count(*) AS n FROM archive_frames').get().n,0);
    f.advance(50);r.tick();assert.equal(r.adapter.db.prepare('SELECT count(*) AS n FROM archive_frames').get().n,1);
    const tail=Buffer.from([123,0]);r.append(f.actor,tail,f.clock());const sealed=r.stopCapture();assert(sealed.endFrame>=12001);
    const s=r.adapter.session(sealed.sessionId),media=r.adapter.tracks(s);assert.equal(media.tracks[0].pcm.readInt16LE(24000),123);
    assert.throws(()=>r.append(f.actor,pcm,f.clock()),/STOPPED/);
  }finally{await r.close();}
});
test('rotation and restart process serially when permitted; one speaker needs one ASR and empty transcript no model',async t=>{
  const f=await setup(t);let calls=0,active=0,peak=0;
  const fetcher=async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return new Response(JSON.stringify({segments:[],duration:1,language:'ja'}),{headers:{'content-type':'application/json'}});};
  const analyzer={analyze:async()=>{throw Error('empty transcript must not call model');}};
  let r=new ArchiveRuntime({...f,analyzer,fetcher,authorize:()=>true});const pcm=Buffer.from([50,0]);r.append(f.actor,pcm,f.clock());f.advance(55000);r.tick();assert.equal(r.current,null);await r.close();
  f.config.archive.canProcess=true;r=new ArchiveRuntime({...f,analyzer,fetcher,authorize:()=>true});try{
    const [a,b]=await Promise.all([r.processPending(),r.processPending()]);assert.equal(a.length,1);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(peak,1);
    const dir=path.join(f.config.archive.archiveRoot,a[0].sessionId);const raw=JSON.parse(await readFile(path.join(dir,'transcript.json')));assert.equal(raw.mixedDerivedFromIndividual,true);
    // Completed jobs do not consume the pending-session budget.
    for(let i=0;i<3;i++){f.advance(1000);r.append(f.actor,pcm,f.clock());r.seal();await r.processPending();}
    assert.equal(calls,4);assert.equal(f.store.tasks(f.actor).length,0);
  }finally{await r.close();}
});
test('remote owner and changed installation identity are refused',async t=>{
  const f=await setup(t);assert.throws(()=>new ArchiveRuntime({...f,config:{...f.config,owner:{kind:'remote'}},authorize:()=>true,analyzer:{}}),/REMOTE_OWNER/);
  const r=new ArchiveRuntime({...f,analyzer:{},authorize:()=>true});try{const pcm=Buffer.from([10,0]);r.append(f.actor,pcm,f.clock());f.config.agentBinding.vmId='different';assert.throws(()=>r.append(f.actor,pcm,f.clock()),/SCOPE_REVOKED/);f.config.agentBinding.vmId='fixture-vm';}finally{await r.close();}
});

test('restart seals the last durable capture frame without claiming unflushed audio',async t=>{
  const f=await setup(t);let r=new ArchiveRuntime({...f,authorize:()=>true,analyzer:{}});const pcm=Buffer.alloc(1920);pcm.writeInt16LE(100,0);r.append(f.actor,pcm,f.clock());r.flush(f.actor);const id=r.current.binding.sessionId;
  clearInterval(r.timer);if(r.startup)clearImmediate(r.startup);r.adapter.close();r.closed=true;
  r=new ArchiveRuntime({...f,authorize:()=>true,analyzer:{}});try{const recovered=r.adapter.session(id);assert.equal(recovered.state,'queued');assert.equal(recovered.end_frame,960);assert.equal(r.adapter.tracks(recovered).tracks[0].pcm.readInt16LE(0),100);}finally{await r.close();}
});

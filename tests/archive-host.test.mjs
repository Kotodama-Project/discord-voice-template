import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {ArchiveAdapter} from '../src/archive-adapter.mjs';
import {createArchiveSink,createWhisperArchiveAsr,createLunaArchiveCorrector,createArchiveIntentRecorder} from '../src/archive-host.mjs';
import {Store} from '../src/store.mjs';
const ffmpeg=process.env.FFMPEG_BIN??'ffmpeg';
test('real ffmpeg, multipart Whisper fixture, CLI correction and existing Source/Intent survive restart without PCM duplication',async t=>{
  assert.equal(spawnSync(ffmpeg,['-version'],{windowsHide:true}).status,0,'ffmpeg must be installed for this acceptance');
  const root=await mkdtemp(path.join(os.tmpdir(),'archive-host-'));const archiveRoot=path.join(root,'recordings');await mkdir(archiveRoot);
  const b={sessionId:'session-fixture',guildId:'100000000000000001',channelId:'100000000000000002',startedAtMs:Date.now(),sampleRateHz:48000,channels:1,sampleFormat:'s16le',speakerIds:['100000000000000003','100000000000000004'],sourceRef:'fixture-source',retentionPolicyRef:'fixture-retention',actorId:'100000000000000003',readers:['100000000000000003']};
  let requests=0;const server=http.createServer(async(req,res)=>{let n=0;const chunks=[];for await(const c of req){chunks.push(c);n+=c.length;}const data=Buffer.concat(chunks);assert(n>100);assert(data.includes(Buffer.from('name="audio"')));requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({language:'ja',duration:1,segments:[{start:0,end:0.5,text:'ことだま',avg_logprob:Math.log(.9)}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const authorize=()=>true,sink=createArchiveSink({archiveRoot,ffmpeg,authorize});
  const asr=createWhisperArchiveAsr({sink,endpoint:`http://127.0.0.1:${server.address().port}/transcribe`,authorize});
  const cli=path.join(root,'model.mjs');await writeFile(cli,`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({edits:[]})}})));`);
  const correct=createLunaArchiveCorrector({command:{executable:process.execPath,args:[cli],model:'gpt-5.6-luna',timeoutSeconds:10},cwd:root,dataDir:path.join(root,'model-runs'),authorize});
  const store=new Store(path.join(root,'existing-owner'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});let fail=true;
  const record=createArchiveIntentRecorder({store,analyzer:{analyze:async()=>({intents:[{kind:'proposal',title:'fixture',request:'fixture',action:'none',explicit:false,complete:true,acceptance:[]}]})},sink,authorize});
  const cfg={journalPath:path.join(root,'queue.sqlite'),authorize,sink,asr,correct,recordIntent:async x=>{if(fail)throw Error('temporary intent failure');return record(x);}};
  let adapter=new ArchiveAdapter(cfg);adapter.begin(b);const pcm=Buffer.alloc(96000);for(let i=0;i<48000;i++)pcm.writeInt16LE(Math.round(Math.sin(i/48000*440*Math.PI*2)*3000),i*2);
  adapter.append({sessionId:b.sessionId,speakerId:b.speakerIds[0],sourceId:'frame-one',startFrame:0,pcm});adapter.append({sessionId:b.sessionId,speakerId:b.speakerIds[1],sourceId:'frame-two',startFrame:0,pcm});adapter.seal(b.sessionId,48000);
  try{await assert.rejects(adapter.processNext(),/temporary intent failure/);}catch(e){adapter.close();console.error(e);throw e;}
  assert.equal(adapter.db.prepare('SELECT count(*) AS n FROM archive_frames').get().n,0);assert.equal(requests,3);adapter.close();
  fail=false;adapter=new ArchiveAdapter(cfg);const result=await adapter.processNext();assert.equal(result.state,'done');assert.equal(requests,3);assert.equal(store.tasks(b.actorId).length,0);assert.equal(store.sources(b.actorId).length,1);
  const dir=path.join(archiveRoot,b.sessionId),metadata=JSON.parse(await readFile(path.join(dir,'metadata.json'))),speakers=JSON.parse(await readFile(path.join(dir,'speakers.json')));
  assert.equal(metadata.retention.rawAudioDays,30);assert.equal(metadata.timeline.alignment,'session_start_silence_padded');assert.equal(speakers.file0.id,'mixed');assert.equal(speakers.file1.id,b.speakerIds[0]);
  const receipt=JSON.parse(await readFile(path.join(dir,'archive-receipt.json')));assert.equal(receipt.files.length,6);assert((await readFile(path.join(dir,b.speakerIds[0]+'.pcm'))).equals(pcm));
  const tx=JSON.parse(await readFile(path.join(dir,'transcript.json')));assert.equal(tx.status,'succeeded');assert.equal(tx.individual.length,2);assert.equal((await adapter.processNext()),null);adapter.close();
  const replay=await sink.seal({binding:b,endFrame:48000,tracks:b.speakerIds.map((speakerId,i)=>({speakerId,pcm:i?Buffer.alloc(96000):pcm})),mixed:pcm,sourceChunks:[],idempotencyKey:receipt.idempotencyKey});assert.deepEqual(replay,receipt);
  const expired=createArchiveSink({archiveRoot,ffmpeg,authorize,clock:()=>b.startedAtMs+31*86400000});await assert.rejects(expired.verify(receipt,b),/EXPIRED/);
  if(process.env.ARCHIVE_RETENTION_FIXTURE)await cp(archiveRoot,process.env.ARCHIVE_RETENTION_FIXTURE,{recursive:true,force:false,errorOnExist:true});
  await writeFile(path.join(dir,b.speakerIds[0]+'.pcm'),'tampered');await assert.rejects(sink.verify(receipt,b),/CHANGED/);
});

test('Whisper rejects a claimed foreign speaker instead of relabeling it',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'archive-asr-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'alice.mp3'),'audio');
  const {digest}=await import('../src/common.mjs');const fn=createWhisperArchiveAsr({sink:{verify:async()=>root},endpoint:'http://127.0.0.1:1/transcribe',authorize:()=>true,fetcher:async()=>new Response(JSON.stringify({duration:1,language:'ja',segments:[{start:0,end:1,text:'x',speaker_id:'bob'}]}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(fn({receipt:{files:[{ref:'alice.mp3',size:5,sha256:digest('audio')}]},speakerId:'alice',source:'individual',binding:{speakerIds:['alice']}}),/SPEAKER_MISMATCH/);
});
test('OpenAI whisper protocol sends file field, model and bearer key, and retains full text without segments',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'archive-openai-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'alice.mp3'),'audio');
  const {digest}=await import('../src/common.mjs');let seen={};
  const fn=createWhisperArchiveAsr({sink:{verify:async()=>root},endpoint:'https://api.openai.com/v1/audio/transcriptions',authorize:()=>true,protocol:'openai',model:'whisper-1',apiKeyEnv:'FIXTURE_WHISPER_KEY',readEnv:()=>'fixture-key',
    fetcher:async(url,init)=>{seen.url=String(url);seen.auth=init.headers.authorization;const text=await new Response(init.body).text();seen.body=text;return new Response(JSON.stringify({text:'全文です',duration:1,language:'ja'}),{headers:{'content-type':'application/json'}});}});
  const segments=await fn({receipt:{files:[{ref:'alice.mp3',size:5,sha256:digest('audio')}]},speakerId:'alice',source:'individual',binding:{speakerIds:['alice']}});
  assert.deepEqual(segments,[{idx:0,start:0,end:1,text:'全文です',confidence:.8,speaker_id:'alice'}]);assert.equal(seen.url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(seen.auth,'Bearer fixture-key');
  assert(seen.body.includes('name="file"'));assert(seen.body.includes('name="model"'));assert(seen.body.includes('verbose_json'));assert(seen.body.includes('timestamp_granularities'));
  assert.throws(()=>createWhisperArchiveAsr({sink:{},endpoint:'https://api.openai.com/v1/audio/transcriptions',authorize:()=>true,protocol:'openai'}),/ARCHIVE_ASR_CREDENTIAL_REQUIRED/);
});
test('fused transcript orders participant and GPT Live speech by the shared timeline',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'archive-fused-')),dir=path.join(root,'session-order');await mkdir(dir);const store=new Store(path.join(root,'data'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});const binding={sessionId:'session-order',guildId:'100000000000000001',channelId:'100000000000000002',startedAtMs:Date.now(),actorId:'100000000000000003',readers:['100000000000000003'],sourceRef:'fixture'};const corrected=[{speaker_id:'kotodama-assistant',idx:0,start:2,end:3,text:'二番目',confidence:1},{speaker_id:'100000000000000003',idx:0,start:0,end:1,text:'最初',confidence:1}];let analyzed;const record=createArchiveIntentRecorder({store,analyzer:{analyze:async source=>{analyzed=source;return {intents:[]};}},sink:{verify:async()=>dir},authorize:()=>true});await record({binding,receipt:{archiveRef:dir},raw:{individual:corrected,mixed:[]},corrected,idempotencyKey:'b'.repeat(64)});const fused=JSON.parse(await readFile(path.join(dir,'fused.json'),'utf8'));assert.deepEqual(fused.segments.map(s=>s.text),['最初','二番目']);assert(store.sources(binding.actorId)[0].text.indexOf('最初')<store.sources(binding.actorId)[0].text.indexOf('二番目'));assert.equal(analyzed.text,'[0-1] 100000000000000003: 最初');assert.equal(analyzed.metadata.intentSpeakerId,binding.actorId);
});
test('encoder failure keeps one bounded staging job and journal PCM for recovery',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'archive-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sink=createArchiveSink({archiveRoot:root,ffmpeg:path.join(root,'not-installed'),authorize:()=>true});
  const input={binding:{sessionId:'session-fail',sampleRateHz:48000,channels:1,speakerIds:['alice'],startedAtMs:Date.now()},endFrame:48,tracks:[{speakerId:'alice',pcm:Buffer.alloc(96)}],mixed:Buffer.alloc(96),sourceChunks:[],idempotencyKey:'a'.repeat(64)};
  await assert.rejects(sink.seal(input));await assert.rejects(sink.seal(input),/EEXIST/);assert.equal((await readdir(root)).filter(n=>n.startsWith('.archive-')).length,1);
});

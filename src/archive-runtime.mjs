import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ArchiveAdapter} from './archive-adapter.mjs';
import {createArchiveSink,createWhisperArchiveAsr,createLunaArchiveCorrector,createArchiveIntentRecorder} from './archive-host.mjs';
import {check} from './common.mjs';

/** Source-only integration seam. VoiceRoom remains the sole receiver owner. */
export class ArchiveRuntime {
  constructor({config,policy=()=>config,store,analyzer,authorize,readEnv,sdk,fetcher,clock=Date.now,onError=()=>{},onUsage=()=>{}}){
    check(config.owner?.kind==='local','ARCHIVE_REMOTE_OWNER_UNSUPPORTED');
    const a=structuredClone(config.archive);check(a?.enabled===true&&typeof a.archiveRoot==='string'&&typeof a.journalPath==='string'&&typeof a.retentionPolicyRef==='string'&&typeof a.sourceRef==='string','ARCHIVE_RUNTIME_CONFIG');
    check(config.installation&&config.agentBinding?.agentId&&config.agentBinding?.vmId,'ARCHIVE_INSTALLATION_BINDING');
    check(typeof authorize==='function'&&store&&analyzer&&Array.isArray(a.readers)&&a.readers.includes(a.actorId)&&config.discord.operators?.includes(a.actorId),'ARCHIVE_RUNTIME_OWNER_REQUIRED');
    this.config=structuredClone(config);this.policy=policy;this.clock=clock;this.onError=onError;this.captureEnabled=true;this.closed=false;this.closing=false;this.current=null;this.processing=null;
    this.batchMs=a.batchMs??250;this.rotationMs=a.rotationMs??55000;
    check(Number.isInteger(this.batchMs)&&this.batchMs>=20&&this.batchMs<=250&&Number.isInteger(this.rotationMs)&&this.rotationMs>=1000&&this.rotationMs<=60000,'ARCHIVE_RUNTIME_TIMING');
    const guard=(b,phase)=>{
      const p=policy(),pa=p.archive;
      return p.owner?.kind==='local'&&pa?.enabled===true&&(!['process','asr','correct','intent'].includes(phase)||pa.canProcess===true)&&p.installation===b.installation&&p.agentBinding?.vmId===b.vmId&&p.agentBinding?.agentId===b.agentId&&p.discord?.guildId===b.guildId&&p.discord?.voiceChannelId===b.channelId&&p.discord.operators?.includes(b.actorId)&&pa.archiveRoot===a.archiveRoot&&pa.journalPath===a.journalPath&&pa.retentionPolicyRef===b.retentionPolicyRef&&pa.sourceRef===b.sourceRef&&pa.actorId===b.actorId&&b.readers.every(id=>pa.readers?.includes(id))&&b.speakerIds.every(id=>p.voice?.participantIds?.includes(id))&&authorize(b,phase)===true;
    };
    this.guard=guard;
    const sink=createArchiveSink({archiveRoot:a.archiveRoot,ffmpeg:a.ffmpeg??'ffmpeg',authorize:guard,clock,maxPcmBytes:a.maxPcmBytes??128*1024*1024});
    const asr=createWhisperArchiveAsr({sink,endpoint:a.whisperEndpoint,authorize:guard,timeoutMs:a.whisperTimeoutMs??120000,fetcher,protocol:a.whisperProtocol??'local',model:a.whisperModel,apiKeyEnv:a.whisperApiKeyEnv,readEnv});
    const correct=createLunaArchiveCorrector({command:structuredClone(config.analyzer),cwd:config.worker.workspace,dataDir:path.join(config.dataDir,'archive-model'),authorize:guard,readEnv,sdk,onUsage,vocabulary:a.vocabulary??[]});
    const recordIntent=createArchiveIntentRecorder({store,analyzer,sink,authorize:guard});
    this.adapter=new ArchiveAdapter({journalPath:a.journalPath,authorize:guard,sink,asr,correct,recordIntent,limits:{maxFrames:Math.ceil(this.rotationMs*48)+48000,maxPcmBytes:a.maxPcmBytes??128*1024*1024,maxSessions:a.maxPendingSessions??16,maxJournalPcmBytes:a.maxJournalPcmBytes??512*1024*1024}});
    for(const row of this.adapter.db.prepare("SELECT id FROM archive_sessions WHERE state='capturing'").all()){
      const prior=this.adapter.session(row.id);if(!guard(prior.binding,'seal'))continue;
      const end=this.adapter.db.prepare('SELECT max(start_frame+length(pcm)/2) AS frame FROM archive_frames WHERE session=?').get(row.id).frame;
      if(end)this.adapter.seal(row.id,end);else this.adapter.db.prepare("UPDATE archive_sessions SET state='discarded_empty' WHERE id=?").run(row.id);
    }
    this.timer=setInterval(()=>{try{this.tick();}catch(e){this.report(e);}},this.batchMs);this.timer.unref();
    // Queued sessions are already durable. Do not invent a new session at startup.
    this.startup=setImmediate(()=>{this.startup=null;this.kick();});
  }
  binding(startedAtMs){const p=this.policy(),a=p.archive;return {sessionId:'session-'+randomUUID(),guildId:p.discord.guildId,channelId:p.discord.voiceChannelId,startedAtMs,sampleRateHz:48000,channels:1,sampleFormat:'s16le',speakerIds:[...(a.speakerIds??p.voice.participantIds)],sourceRef:a.sourceRef,retentionPolicyRef:a.retentionPolicyRef,actorId:a.actorId,readers:[...a.readers],installation:p.installation,agentId:p.agentBinding.agentId,vmId:p.agentBinding.vmId};}
  start(time){const binding=this.binding(time);check(this.guard(binding,'capture'),'ARCHIVE_SCOPE_REVOKED');this.adapter.begin(binding);this.current={binding,batches:new Map(),cursors:new Map(),lastWalls:new Map(),endFrame:0,sequence:0};}
  append(speakerId,pcm48Mono,wallTimeMs){
    check(!this.closed&&!this.closing&&this.captureEnabled,'ARCHIVE_CAPTURE_STOPPED');
    check(Buffer.isBuffer(pcm48Mono)&&pcm48Mono.length>0&&pcm48Mono.length%2===0&&pcm48Mono.length<=96000&&Number.isSafeInteger(wallTimeMs)&&wallTimeMs>=0,'ARCHIVE_PACKET_INVALID');
    const p=this.policy();check(p.voice.participantIds.includes(speakerId),'ARCHIVE_SPEAKER_MISMATCH');
    // Digital silence creates neither a recording job nor model work.
    if(!this.current&&pcm48Mono.every(x=>x===0))return {ignoredSilence:true};
    if(this.current&&wallTimeMs>=this.current.binding.startedAtMs+this.rotationMs)this.seal();
    if(this.current&&!this.current.binding.speakerIds.includes(speakerId))this.seal();
    if(!this.current)this.start(wallTimeMs);
    const s=this.current;check(this.guard(s.binding,'capture'),'ARCHIVE_SCOPE_REVOKED');
    check(s.binding.speakerIds.includes(speakerId)&&wallTimeMs>=s.binding.startedAtMs&&wallTimeMs>=(s.lastWalls.get(speakerId)??0),'ARCHIVE_PACKET_TIME');
    s.lastWalls.set(speakerId,wallTimeMs);
    let frame=Math.max(Math.floor((wallTimeMs-s.binding.startedAtMs)*48),s.cursors.get(speakerId)??0);
    check(frame+pcm48Mono.length/2<=this.adapter.limits.maxFrames,'ARCHIVE_ROTATION_REQUIRED');
    const maxBytes=this.batchMs*96;let offset=0;
    while(offset<pcm48Mono.length){
      let batch=s.batches.get(speakerId);
      if(batch&&batch.startFrame+batch.bytes/2!==frame){this.flush(speakerId);batch=null;}
      if(!batch){batch={startFrame:frame,chunks:[],bytes:0,createdAt:this.clock(),sourceId:'batch-'+s.sequence++};s.batches.set(speakerId,batch);}
      const n=Math.min(maxBytes-batch.bytes,pcm48Mono.length-offset);batch.chunks.push(Buffer.from(pcm48Mono.subarray(offset,offset+n)));batch.bytes+=n;offset+=n;frame+=n/2;
      s.cursors.set(speakerId,frame);s.endFrame=Math.max(s.endFrame,frame);
      if(batch.bytes===maxBytes)this.flush(speakerId);
    }
    return {sessionId:s.binding.sessionId};
  }
  flush(speakerId){const s=this.current,b=s?.batches.get(speakerId);if(!b)return;
    this.adapter.append({sessionId:s.binding.sessionId,speakerId,sourceId:b.sourceId,startFrame:b.startFrame,pcm:Buffer.concat(b.chunks,b.bytes)});s.batches.delete(speakerId);
  }
  tick(){if(this.closed||this.closing)return;const s=this.current;if(s){for(const [id,b]of s.batches)if(this.clock()-b.createdAt>=this.batchMs)this.flush(id);if(this.clock()-s.binding.startedAtMs>=this.rotationMs)this.seal();}}
  seal(){const s=this.current;if(!s)return null;for(const id of [...s.batches.keys()])this.flush(id);const endFrame=Math.max(s.endFrame,Math.min(this.rotationMs*48,Math.max(0,Math.floor((this.clock()-s.binding.startedAtMs)*48))));this.adapter.seal(s.binding.sessionId,endFrame);this.current=null;this.kick();return {sessionId:s.binding.sessionId,endFrame};}
  stopCapture(){this.captureEnabled=false;return this.seal();}
  report(e){if(e.message==='ARCHIVE_DISK_RESERVE'){this.captureEnabled=false;clearInterval(this.timer);}this.onError(/^(ARCHIVE_|OPENAI_)[A-Z_]+$/.test(e.message)?e.message:'ARCHIVE_OPERATION_FAILED');}
  kick(){if(!this.closed&&!this.closing)void this.processPending().catch(e=>this.report(e));}
  processPending(){
    if(this.processing)return this.processing;
    if(this.closed||this.closing)return Promise.resolve([]);
    const allowed=()=>this.policy().archive?.canProcess===true;
    // Caller supplies occupancy/load; absence never means permission to spend.
    if(!allowed())return Promise.resolve([]);
    const promise=(async()=>{const results=[];while(!this.closed&&!this.closing&&allowed()){const r=await this.adapter.processNext();if(!r)break;results.push(r);}return results;})();
    this.processing=promise.finally(()=>{this.processing=null;});return this.processing;
  }
  async close(){if(this.closed)return;if(this.closing){await this.processing;return;}clearInterval(this.timer);if(this.startup)clearImmediate(this.startup);this.captureEnabled=false;this.closing=true;
    let sealError;try{this.seal();}catch(e){sealError=e;}try{await this.processing;}finally{this.adapter.close();this.closed=true;}if(sealError)throw sealError;
  }
}

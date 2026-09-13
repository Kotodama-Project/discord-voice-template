import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,realpathSync,chmodSync,statfsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hash=x=>createHash('sha256').update(x).digest('hex');
const requireValue=(x,c)=>{if(!x)throw new Error(c);};
const token=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const clone=x=>JSON.parse(JSON.stringify(x));

/** Durable capture staging, NOT a Task store. One externally fenced owner only.
 * Archive persistence and retention remain owned by the existing archive sink.
 */
export class ArchiveAdapter {
  constructor({journalPath,authorize,sink,asr,correct,recordIntent,limits={}}){
    requireValue([authorize,sink?.seal,asr,correct,recordIntent].every(x=>typeof x==='function'),'ARCHIVE_ADAPTERS_REQUIRED');
    this.authorize=authorize;this.sink=sink;this.asr=asr;this.correct=correct;this.recordIntent=recordIntent;
    this.limits={maxSessions:16,maxSpeakers:16,maxFrames:48000*1800,maxPcmBytes:128*1024*1024,maxJournalPcmBytes:512*1024*1024,minFreeBytes:512*1024*1024,maxSegments:4096,maxChunks:200000,...limits};
    requireValue(Object.values(this.limits).every(x=>integer(x)&&x>0),'ARCHIVE_LIMIT_INVALID');
    mkdirSync(path.dirname(journalPath),{recursive:true,mode:0o700});
    requireValue(!lstatSync(path.dirname(journalPath)).isSymbolicLink(),'ARCHIVE_LINK_REFUSED');
    try{requireValue(!lstatSync(journalPath).isSymbolicLink(),'ARCHIVE_LINK_REFUSED');}catch(e){if(e.code!=='ENOENT')throw e;}
    this.db=new DatabaseSync(path.join(realpathSync(path.dirname(journalPath)),path.basename(journalPath)));
    chmodSync(journalPath,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS archive_sessions(id TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL,end_frame INTEGER,receipt TEXT,raw TEXT,corrected TEXT,intent_receipt TEXT); CREATE TABLE IF NOT EXISTS archive_frames(session TEXT NOT NULL,source TEXT NOT NULL,speaker TEXT NOT NULL,start_frame INTEGER NOT NULL,pcm BLOB NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(session,source));');
    this.db.exec('PRAGMA secure_delete=ON;');
    this.journalDir=path.dirname(journalPath);this.busy=false;
  }
  session(id){const s=this.db.prepare('SELECT * FROM archive_sessions WHERE id=?').get(id);requireValue(s,'ARCHIVE_SESSION_UNKNOWN');return {...s,binding:JSON.parse(s.binding)};}
  allowed(b,phase){requireValue(this.authorize(clone(b),phase)===true,'ARCHIVE_SCOPE_REVOKED');}
  begin(binding){
    const b=clone(binding);requireValue(token(b.sessionId)&&token(b.guildId)&&token(b.channelId)&&integer(b.startedAtMs)&&b.sampleRateHz===48000&&b.channels===1&&b.sampleFormat==='s16le','ARCHIVE_BINDING_INVALID');
    requireValue(typeof b.sourceRef==='string'&&b.sourceRef.length>0&&b.sourceRef.length<=1000&&typeof b.retentionPolicyRef==='string'&&b.retentionPolicyRef.length>0&&b.retentionPolicyRef.length<=1000&&JSON.stringify(b).length<=16000,'ARCHIVE_POLICY_REQUIRED');
    requireValue(Array.isArray(b.speakerIds)&&b.speakerIds.length>0&&b.speakerIds.length<=this.limits.maxSpeakers&&b.speakerIds.every(token)&&new Set(b.speakerIds).size===b.speakerIds.length&&!b.speakerIds.includes('mixed'),'ARCHIVE_SPEAKERS_INVALID');
    this.allowed(b,'capture');const old=this.db.prepare('SELECT binding FROM archive_sessions WHERE id=?').get(b.sessionId);
    if(old){requireValue(old.binding===JSON.stringify(b),'ARCHIVE_BINDING_CONFLICT');return;}
    requireValue(this.db.prepare("SELECT count(*) AS n FROM archive_sessions WHERE state IN ('capturing','queued')").get().n<this.limits.maxSessions,'ARCHIVE_SESSION_LIMIT');
    this.db.prepare('INSERT INTO archive_sessions(id,binding,state) VALUES(?,?,?)').run(b.sessionId,JSON.stringify(b),'capturing');
  }
  append({sessionId,speakerId,sourceId,startFrame,pcm}){
    const s=this.session(sessionId);this.allowed(s.binding,'capture');
    requireValue(s.state==='capturing','ARCHIVE_ALREADY_SEALED');requireValue(s.binding.speakerIds.includes(speakerId),'ARCHIVE_SPEAKER_MISMATCH');
    requireValue(token(sourceId)&&integer(startFrame)&&Buffer.isBuffer(pcm)&&pcm.length>0&&pcm.length%2===0&&startFrame+pcm.length/2<=this.limits.maxFrames,'ARCHIVE_FRAME_INVALID');
    const digest=hash(pcm),old=this.db.prepare('SELECT * FROM archive_frames WHERE session=? AND source=?').get(sessionId,sourceId);
    if(old){requireValue(old.speaker===speakerId&&old.start_frame===startFrame&&old.digest===digest,'ARCHIVE_REPLAY_CONFLICT');return {duplicate:true};}
    const end=this.db.prepare('SELECT max(start_frame+length(pcm)/2) AS n FROM archive_frames WHERE session=? AND speaker=?').get(sessionId,speakerId).n??0;
    requireValue(startFrame>=end,'ARCHIVE_TIME_OVERLAP');
    const bytes=this.db.prepare('SELECT coalesce(sum(length(pcm)),0) AS n FROM archive_frames').get().n;
    requireValue(this.db.prepare('SELECT count(*) AS n FROM archive_frames').get().n<this.limits.maxChunks,'ARCHIVE_CHUNK_LIMIT');
    requireValue(bytes+pcm.length<=this.limits.maxJournalPcmBytes,'ARCHIVE_PCM_LIMIT');
    const disk=statfsSync(this.journalDir);requireValue(disk.bavail*disk.bsize>=this.limits.minFreeBytes+pcm.length*3,'ARCHIVE_DISK_RESERVE');
    this.db.prepare('INSERT INTO archive_frames VALUES(?,?,?,?,?,?)').run(sessionId,sourceId,speakerId,startFrame,pcm,digest);return {duplicate:false};
  }
  seal(sessionId,endFrame){
    const s=this.session(sessionId);this.allowed(s.binding,'seal');requireValue(integer(endFrame)&&endFrame>0&&endFrame<=this.limits.maxFrames,'ARCHIVE_END_INVALID');
    if(s.state!=='capturing'){requireValue(s.end_frame===endFrame,'ARCHIVE_SEAL_CONFLICT');return;}
    const last=this.db.prepare('SELECT max(start_frame+length(pcm)/2) AS n FROM archive_frames WHERE session=?').get(sessionId).n;
    requireValue(last!==null&&endFrame>=last,'ARCHIVE_LAST_AUDIO_LOST');
    requireValue(endFrame*2*(s.binding.speakerIds.length+1)<=this.limits.maxPcmBytes,'ARCHIVE_PADDED_LIMIT');
    this.db.prepare("UPDATE archive_sessions SET state='queued',end_frame=? WHERE id=?").run(endFrame,sessionId);
  }
  tracks(s){
    const rows=this.db.prepare('SELECT * FROM archive_frames WHERE session=? ORDER BY start_frame,source').all(s.id);
    const tracks=s.binding.speakerIds.map(speakerId=>({speakerId,pcm:Buffer.alloc(s.end_frame*2)}));
    for(const row of rows){const pcm=Buffer.from(row.pcm);requireValue(hash(pcm)===row.digest,'ARCHIVE_PCM_CHANGED');pcm.copy(tracks.find(t=>t.speakerId===row.speaker).pcm,row.start_frame*2);}
    const mixed=Buffer.alloc(s.end_frame*2);
    for(let i=0;i<mixed.length;i+=2){let n=0;for(const t of tracks)n+=t.pcm.readInt16LE(i);mixed.writeInt16LE(Math.max(-32768,Math.min(32767,n)),i);}
    return {tracks,mixed,sourceChunks:rows.map(r=>({sourceId:r.source,speakerId:r.speaker,startFrame:r.start_frame,frames:r.pcm.length/2,sha256:r.digest}))};
  }
  async processNext(){
    requireValue(!this.busy,'ARCHIVE_PROCESSOR_BUSY');this.busy=true;
    try{
      const row=this.db.prepare("SELECT id FROM archive_sessions WHERE state='queued' ORDER BY rowid LIMIT 1").get();if(!row)return null;
      const s=this.session(row.id),b=s.binding,key=hash(JSON.stringify(b)+':'+s.end_frame);this.allowed(b,'process');
      let receipt=s.receipt&&JSON.parse(s.receipt);
      if(!receipt){
        const media=this.tracks(s);this.allowed(b,'persist');
        receipt=await this.sink.seal({binding:clone(b),endFrame:s.end_frame,...media,idempotencyKey:key});
        this.allowed(b,'persist');requireValue(receipt?.idempotencyKey===key&&receipt.sessionId===s.id&&typeof receipt.archiveRef==='string','ARCHIVE_RECEIPT_INVALID');
        this.db.prepare('UPDATE archive_sessions SET receipt=? WHERE id=?').run(JSON.stringify(receipt),s.id);
      }
      // The real sink verifies durable files before releasing recoverable PCM.
      if(typeof this.sink.verify==='function'){
        await this.sink.verify(clone(receipt),clone(b));this.allowed(b,'process');
        this.db.prepare('DELETE FROM archive_frames WHERE session=?').run(s.id);
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      }
      let raw=s.raw&&JSON.parse(s.raw);
      if(!raw){
        raw={individual:[],mixed:[]};
        // Intentionally serial: real-time Live is never blocked on this queue.
        for(const speakerId of b.speakerIds){this.allowed(b,'asr');const segments=await this.asr({receipt:clone(receipt),speakerId,source:'individual',binding:clone(b)});validateSegments(segments,speakerId,s.end_frame/48000,this.limits.maxSegments);raw.individual.push(...segments.map(x=>({...x,speaker_id:speakerId,source:'individual'})));}
        this.allowed(b,'asr');
        if(b.speakerIds.length===1){raw.mixed=raw.individual.map(({speaker_id,source,...s})=>s);raw.mixedDerivedFromIndividual=true;}
        else raw.mixed=await this.asr({receipt:clone(receipt),speakerId:null,source:'mixed',binding:clone(b)});
        validateSegments(raw.mixed,null,s.end_frame/48000,this.limits.maxSegments);
        requireValue(raw.individual.length<=this.limits.maxSegments,'ARCHIVE_SEGMENT_LIMIT');this.allowed(b,'process');
        this.db.prepare('UPDATE archive_sessions SET raw=? WHERE id=?').run(JSON.stringify(raw),s.id);
      }
      if(typeof this.sink.writeRaw==='function')await this.sink.writeRaw(clone(receipt),clone(b),clone(raw));
      let corrected=s.corrected&&JSON.parse(s.corrected);
      if(!corrected){this.allowed(b,'correct');const edits=raw.individual.some(s=>s.text.trim())?await this.correct({raw:clone(raw),binding:clone(b),receipt:clone(receipt)}):[];corrected=applyArchiveCorrections(raw.individual,edits);this.allowed(b,'correct');this.db.prepare('UPDATE archive_sessions SET corrected=? WHERE id=?').run(JSON.stringify(corrected),s.id);}
      this.allowed(b,'intent');const result=await this.recordIntent({binding:clone(b),receipt:clone(receipt),raw:clone(raw),corrected:clone(corrected),idempotencyKey:key});
      this.allowed(b,'intent');requireValue(result?.idempotencyKey===key&&typeof result.receiptRef==='string','ARCHIVE_INTENT_RECEIPT_INVALID');
      this.db.prepare("UPDATE archive_sessions SET state='done',intent_receipt=? WHERE id=?").run(JSON.stringify(result),s.id);
      return {sessionId:s.id,state:'done',archiveRef:receipt.archiveRef,intentReceipt:result.receiptRef};
    }finally{this.busy=false;}
  }
  close(){requireValue(!this.busy,'ARCHIVE_PROCESSOR_BUSY');this.db.close();}
}
function validateSegments(segments,speakerId,duration,limit){
  requireValue(Array.isArray(segments)&&segments.length<=limit,'ARCHIVE_SEGMENT_LIMIT');const ids=new Set();
  for(const s of segments){requireValue(integer(s.idx)&&!ids.has(s.idx)&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.end>=s.start&&s.end<=duration&&typeof s.text==='string'&&s.text.length<=16000&&Number.isFinite(s.confidence)&&s.confidence>=0&&s.confidence<=1,'ARCHIVE_SEGMENT_INVALID');ids.add(s.idx);requireValue(s.speaker_id===undefined||s.speaker_id===speakerId,'ARCHIVE_SPEAKER_MISMATCH');}
}
export function applyArchiveCorrections(individual,edits){
  requireValue(Array.isArray(edits)&&edits.length<=individual.length,'ARCHIVE_CORRECTIONS_INVALID');const result=clone(individual),seen=new Set();
  for(const e of edits){const key=e.speaker_id+':'+e.idx;requireValue(!seen.has(key),'ARCHIVE_CORRECTION_DUPLICATE');seen.add(key);const s=result.find(x=>x.speaker_id===e.speaker_id&&x.idx===e.idx);
    requireValue(s&&e.start===s.start&&e.end===s.end&&e.before===s.text,'ARCHIVE_CORRECTION_IDENTITY');requireValue(typeof e.after==='string'&&e.after.trim()&&e.after.length<=16000&&typeof e.reason==='string'&&e.reason.trim()&&e.reason.length<=2000&&Number.isFinite(e.confidence)&&e.confidence>=0&&e.confidence<=1,'ARCHIVE_CORRECTION_INVALID');
    s.raw_text=s.text;s.text=e.after;s.correction={before:e.before,after:e.after,reason:e.reason,confidence:e.confidence};
  }return result;
}

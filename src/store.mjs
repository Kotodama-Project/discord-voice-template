import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {check,digest,sourceIdentity,sourceFingerprint,uid} from './common.mjs';

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path.join(dataDir,'kotodama.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sources(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_versions(key TEXT NOT NULL, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key,revision));
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, source_key TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intent_versions(id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, source_key TEXT NOT NULL, source_revision INTEGER NOT NULL, room TEXT NOT NULL, actor TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, type TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(key TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT);
      CREATE TABLE IF NOT EXISTS usage(day TEXT PRIMARY KEY, reserved_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_controls(guild TEXT NOT NULL,channel TEXT NOT NULL,suspension TEXT,PRIMARY KEY(guild,channel));
      CREATE TABLE IF NOT EXISTS voice_consents(guild TEXT NOT NULL,channel TEXT NOT NULL,actor TEXT NOT NULL,notice TEXT NOT NULL,granted INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(guild,channel,actor));
      CREATE TABLE IF NOT EXISTS host_lock(name TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, created TEXT NOT NULL, domain TEXT);
    `);
    if(!this.db.prepare('PRAGMA table_info(voice_consents)').all().some(c=>c.name==='interaction_id'))this.db.exec("ALTER TABLE voice_consents ADD COLUMN interaction_id TEXT NOT NULL DEFAULT '0'");
    if(!this.db.prepare('PRAGMA table_info(host_lock)').all().some(c=>c.name==='domain'))this.db.exec('ALTER TABLE host_lock ADD COLUMN domain TEXT');
  }
  transaction(fn) {this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  event(type,body,taskId=null){this.db.prepare('INSERT INTO events(task_id,type,at,body) VALUES(?,?,?,?)').run(taskId,type,new Date().toISOString(),JSON.stringify(body));}
  claimHost(owner,pid,created,domain=null){this.db.prepare('INSERT INTO host_lock(name,owner,pid,created,domain) VALUES(?,?,?,?,?)').run('runtime',owner,pid,created,domain);}
  replaceStaleHost(stale,owner,pid,created,domain){return this.transaction(()=>{const removed=this.db.prepare('DELETE FROM host_lock WHERE name=? AND owner=? AND pid=? AND created=? AND domain IS ?').run('runtime',stale.owner,stale.pid,stale.created,stale.domain??null);check(removed.changes===1,'RUNTIME_LOCK_CHANGED');this.claimHost(owner,pid,created,domain);});}
  releaseHost(owner){this.db.prepare('DELETE FROM host_lock WHERE name=? AND owner=?').run('runtime',owner);}
  lock(){return this.db.prepare('SELECT * FROM host_lock WHERE name=?').get('runtime');}
  consent(guild,channel,actor,notice){const row=this.db.prepare('SELECT * FROM voice_consents WHERE guild=? AND channel=? AND actor=?').get(guild,channel,actor);return Boolean(row?.granted===1&&row.notice===notice);}
  voiceOptedOut(guild,channel,actor){const row=this.db.prepare('SELECT granted FROM voice_consents WHERE guild=? AND channel=? AND actor=?').get(guild,channel,actor);return row?.granted===0;}
  voiceSuspension(guild,channel){return this.db.prepare('SELECT suspension FROM voice_controls WHERE guild=? AND channel=?').get(guild,channel)?.suspension??null;}
  setVoiceSuspension(guild,channel,suspension){check([null,'pause','leave','budget','provider_credit'].includes(suspension),'VOICE_CONTROL_INVALID');this.db.prepare('INSERT INTO voice_controls VALUES(?,?,?) ON CONFLICT(guild,channel) DO UPDATE SET suspension=excluded.suspension').run(guild,channel,suspension);}
  assertAudioAvailable(capSeconds,totalCapSeconds,day=new Date().toISOString().slice(0,10)){
    check(capSeconds>0,'AUDIO_BUDGET_REQUIRED');
    check((this.db.prepare('SELECT reserved_ms FROM usage WHERE day=?').get(day)?.reserved_ms??0)+1000<=capSeconds*1000,'AUDIO_BUDGET_EXHAUSTED');
    if(totalCapSeconds!==undefined)check(this.db.prepare('SELECT COALESCE(SUM(reserved_ms),0) AS total FROM usage').get().total+1000<=totalCapSeconds*1000,'AUDIO_TOTAL_BUDGET_EXHAUSTED');
  }
  recordConsent({guild,channel,actor,notice,granted,interactionId}){check(guild&&channel&&actor&&notice&&/^\d{5,24}$/.test(interactionId)&&typeof granted==='boolean','CONSENT_EVIDENCE_REQUIRED');return this.transaction(()=>{const old=this.db.prepare('SELECT * FROM voice_consents WHERE guild=? AND channel=? AND actor=?').get(guild,channel,actor);if(old&&BigInt(old.interaction_id)>=BigInt(interactionId)){if(old.interaction_id===interactionId)check(old.notice===notice&&old.granted===Number(granted),'CONSENT_REPLAY_CONFLICT');return {granted:Boolean(old.granted),state:old.interaction_id===interactionId?'duplicate':'stale'};}this.db.prepare('INSERT INTO voice_consents(guild,channel,actor,notice,granted,updated,interaction_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(guild,channel,actor) DO UPDATE SET notice=excluded.notice,granted=excluded.granted,updated=excluded.updated,interaction_id=excluded.interaction_id').run(guild,channel,actor,notice,Number(granted),new Date().toISOString(),interactionId);this.event('voice.consent',{guild,channel,actor,notice,granted,interactionId});return {granted,state:'updated'};});}
  ingest(source) {
    check(source&&['discord','file'].includes(source.provider),'INVALID_SOURCE');
    for(const k of ['guildId','channelId','sourceId'])check(typeof source[k]==='string'&&source[k].length>0,'SOURCE_ID_REQUIRED');
    check(Number.isSafeInteger(source.revision)&&source.revision>=0,'SOURCE_REVISION_REQUIRED');
    check(typeof source.text==='string'&&Buffer.byteLength(source.text)<=2000000,'SOURCE_SIZE_LIMIT');
    check(Array.isArray(source.readers)&&source.readers.every(v=>typeof v==='string'),'SOURCE_READERS_REQUIRED');
    check(typeof source.final==='boolean','SOURCE_FINALITY_REQUIRED');
    const key=sourceIdentity(source),fingerprint=sourceFingerprint(source);
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM sources WHERE key=?').get(key);
      if(old){
        if(source.revision<old.revision)return {key,state:'stale',revision:old.revision};
        if(source.revision===old.revision){check(old.fingerprint===fingerprint,'SOURCE_REVISION_CONFLICT');return {key,state:'duplicate',revision:old.revision};}
        this.db.prepare("UPDATE tasks SET state='stale',revision=revision+1,result=NULL WHERE (source_key=? OR EXISTS(SELECT 1 FROM json_each(tasks.body,'$.contextSources') c WHERE json_extract(c.value,'$.key')=?)) AND state NOT IN ('stale','cancelled')").run(key,key);
        this.db.prepare('DELETE FROM intents WHERE source_key=?').run(key);
      }
      this.db.prepare('INSERT INTO source_versions VALUES(?,?,?,?)').run(key,source.revision,fingerprint,JSON.stringify({...source,key}));
      this.db.prepare('INSERT INTO sources VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,body=excluded.body').run(key,source.revision,fingerprint,JSON.stringify({...source,key}));
      this.event(old?'source.corrected':'source.created',{source_key:key,revision:source.revision});
      return {key,state:old?'corrected':'created',revision:source.revision};
    });
  }
  source(key,actor){const row=this.db.prepare('SELECT * FROM sources WHERE key=?').get(key);check(row,'SOURCE_NOT_FOUND');const s=JSON.parse(row.body);check(!s.withdrawn&&s.readers.includes(actor),'SOURCE_ACCESS_DENIED');return s;}
  sourceInternal(key){const row=this.db.prepare('SELECT body FROM sources WHERE key=?').get(key);return row?JSON.parse(row.body):null;}
  sources(actor,room=null){return this.db.prepare('SELECT body FROM sources ORDER BY revision,key').all().map(r=>JSON.parse(r.body)).filter(s=>!s.withdrawn&&s.readers.includes(actor)&&(!room||room===`${s.provider}:${s.guildId}:${s.channelId}`));}
  saveIntents(source,items,principal=source.actorId){return this.transaction(()=>{
    const current=this.source(source.key,principal);check(current.revision===source.revision,'SOURCE_CHANGED');
    return items.map((item,index)=>{const id=digest([source.key,index]);const body=JSON.stringify({...item,id,source_key:source.key,source_revision:source.revision});this.db.prepare('INSERT INTO intent_versions VALUES(?,?,?) ON CONFLICT(id,revision) DO NOTHING').run(id,source.revision,body);this.db.prepare('INSERT INTO intents VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(id,source.key,source.revision,body);return id;});
  });}
  listIntents(actor){return this.db.prepare('SELECT * FROM intents').all().flatMap(row=>{try{this.source(row.source_key,actor);const i=JSON.parse(row.body);for(const b of i.contextSources??[]){const s=this.source(b.key,actor);check(s.revision===b.revision,'CONTEXT_CHANGED');}return [i];}catch{return [];}});}
  createTask(source,intent){
    check(source.actorId&&source.final&&!source.withdrawn,'FINAL_AUTHENTICATED_SOURCE_REQUIRED');
    const requestKey=digest([source.key,intent.key??intent.id??digest(intent)]);
    return this.transaction(()=>{
      const current=this.source(source.key,source.actorId);check(current.revision===source.revision,'SOURCE_CHANGED');
      const old=this.db.prepare('SELECT id FROM tasks WHERE request_key=?').get(requestKey);if(old){const task=this.task(old.id,source.actorId);if(task.source_revision!==source.revision)return this.reviseTask(old.id,source,intent);return task;}
      const id=uid('task');const task={id,source_key:source.key,source_revision:source.revision,room:`${source.provider}:${source.guildId}:${source.channelId}`,actor:source.actorId,title:intent.title,request:intent.request,action:intent.action,intentIds:intent.intentIds??[],requiredActions:intent.requiredActions??[intent.action],acceptance:intent.acceptance??[],contextSources:intent.contextSources??[],createdAt:new Date().toISOString()};
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id,requestKey,source.key,source.revision,task.room,source.actorId,1,'queued',JSON.stringify(task));this.event('task.created',{source_key:source.key,action:task.action},id);return this.task(id,source.actorId);
    });
  }
  taskInternal(id){const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);check(row,'TASK_NOT_FOUND');return {...JSON.parse(row.body),revision:row.revision,state:row.state,result:row.result?JSON.parse(row.result):null};}
  bindContext(id,revision,bindings){const t=this.taskInternal(id);check(t.revision===revision&&t.state==='running','TASK_CHANGED');for(const b of bindings){const s=this.source(b.key,t.actor);check(s.revision===b.revision,'CONTEXT_CHANGED');}const body={...t,contextSources:bindings};delete body.result;delete body.state;delete body.revision;const r=this.db.prepare("UPDATE tasks SET body=? WHERE id=? AND revision=? AND state='running'").run(JSON.stringify(body),id,revision);check(r.changes===1,'TASK_CHANGED');this.event('task.context_bound',{bindings},id);}
  assertContext(id,actor){const t=this.taskInternal(id);check(t.actor===actor,'TASK_ACCESS_DENIED');for(const b of t.contextSources??[]){const s=this.source(b.key,actor);check(s.revision===b.revision,'CONTEXT_CHANGED');}return true;}
  reviseTask(id,source,intent){const old=this.task(id,source.actorId);check(old.room===`${source.provider}:${source.guildId}:${source.channelId}`,'TASK_ROOM_MISMATCH');const updated={...old,source_key:source.key,source_revision:source.revision,request:intent.request,title:intent.title,action:intent.action,intentIds:intent.intentIds??[],requiredActions:intent.requiredActions??[intent.action],acceptance:intent.acceptance??old.acceptance,contextSources:intent.contextSources??[]};delete updated.result;delete updated.state;delete updated.revision;const r=this.db.prepare("UPDATE tasks SET source_key=?,source_revision=?,revision=revision+1,state='queued',body=?,result=NULL WHERE id=? AND revision=?").run(source.key,source.revision,JSON.stringify(updated),id,old.revision);check(r.changes===1,'TASK_CHANGED');this.event('task.corrected',{previousSource:old.source_key,source:source.key,sourceRevision:source.revision,previousIntentIds:old.intentIds??[],intentIds:updated.intentIds},id);return this.task(id,source.actorId);}
  task(id,actor){const t=this.taskInternal(id);check(t.actor===actor,'TASK_ACCESS_DENIED');this.source(t.source_key,actor);if(t.state!=='stale')this.assertContext(id,actor);else for(const b of t.contextSources??[])this.source(b.key,actor);return t;}
  tasks(actor){return this.db.prepare('SELECT id FROM tasks WHERE actor=? ORDER BY rowid DESC').all(actor).flatMap(r=>{try{return [this.task(r.id,actor)];}catch{return [];}});}
  claim(id,revision){const r=this.db.prepare("UPDATE tasks SET state='running' WHERE id=? AND revision=? AND state='queued'").run(id,revision);check(r.changes===1,'TASK_NOT_QUEUED');this.event('task.started',{revision},id);}
  finish(id,revision,result){check(['needs_review','failed','uncertain'].includes(result.state),'INVALID_RESULT_STATE');const t=this.taskInternal(id);const s=this.sourceInternal(t.source_key);check(s&&!s.withdrawn&&s.revision===t.source_revision,'SOURCE_CHANGED');this.assertContext(id,t.actor);const r=this.db.prepare("UPDATE tasks SET state=?,result=? WHERE id=? AND revision=? AND state='running'").run(result.state,JSON.stringify(result),id,revision);check(r.changes===1,'TASK_CHANGED');this.event('task.result',{state:result.state,artifact_count:result.artifacts?.length??0},id);}
  cancel(id,actor){const t=this.task(id,actor);if(['stopping','cancelled','uncertain'].includes(t.state))return t;this.db.prepare('UPDATE tasks SET state=?,revision=revision+1,result=NULL WHERE id=?').run(t.state==='running'?'stopping':'cancelled',id);this.event('task.stop_requested',{},id);return t;}
  confirmStop(id,actor,confirmed){const t=this.task(id,actor);check(t.state==='stopping','TASK_NOT_STOPPING');this.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(confirmed?'cancelled':'uncertain',id);this.event('task.stop_observed',{confirmed},id);}
  resume(id,actor){const t=this.task(id,actor);check(['cancelled','failed'].includes(t.state),'TASK_CANNOT_RESUME');const s=this.source(t.source_key,actor);check(s.revision===t.source_revision,'SOURCE_CHANGED');this.db.prepare("UPDATE tasks SET state='queued',revision=revision+1,result=NULL WHERE id=?").run(id);this.event('task.resumed',{},id);return this.task(id,actor);}
  reconcileInterrupted(){this.db.prepare("UPDATE tasks SET state='uncertain' WHERE state IN ('running','stopping')").run();}
  claimDelivery(key,body){return this.transaction(()=>{const hash=digest(body),old=this.db.prepare('SELECT * FROM deliveries WHERE key=?').get(key);if(old){check(old.digest===hash,'DELIVERY_CONFLICT');return false;}this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,NULL)').run(key,hash,'unknown');return true;});}
  delivered(key,messageId){this.db.prepare("UPDATE deliveries SET state='sent',message_id=? WHERE key=?").run(messageId,key);}
  deliveryState(key){return this.db.prepare('SELECT state FROM deliveries WHERE key=?').get(key)?.state??null;}
  reserveAudio(milliseconds,capSeconds,day=new Date().toISOString().slice(0,10),totalCapSeconds){return this.transaction(()=>{check(Number.isSafeInteger(milliseconds)&&milliseconds>0&&capSeconds>0,'AUDIO_BUDGET_REQUIRED');const old=this.db.prepare('SELECT reserved_ms FROM usage WHERE day=?').get(day)?.reserved_ms??0;check(old+milliseconds<=capSeconds*1000,'AUDIO_BUDGET_EXHAUSTED');if(totalCapSeconds!==undefined){const total=this.db.prepare('SELECT COALESCE(SUM(reserved_ms),0) AS total FROM usage').get().total;check(total+milliseconds<=totalCapSeconds*1000,'AUDIO_TOTAL_BUDGET_EXHAUSTED');}this.db.prepare('INSERT INTO usage VALUES(?,?) ON CONFLICT(day) DO UPDATE SET reserved_ms=excluded.reserved_ms').run(day,old+milliseconds);return old+milliseconds;});}
  close(){this.db.close();}
}

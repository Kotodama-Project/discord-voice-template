import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/store.mjs';
import {NotificationQueue} from '../src/notifications.mjs';
import {exampleConfig} from '../src/config.mjs';
import {startRuntime} from '../src/runtime.mjs';
import {digest} from '../src/common.mjs';

const actor='100000000000000002';
const source=id=>({provider:'discord',guildId:'100000000000000001',channelId:'100000000000000003',sourceId:id,actorId:actor,revision:1,readers:[actor],text:'Synthetic request',final:true});
const intent={title:'Synthetic work',request:'Synthetic request',action:'research',acceptance:[]};
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'ktdm-store-compatibility-')),dataDir=path.join(root,'data');
  await mkdir(dataDir);t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,dataDir,filename:path.join(dataDir,'kotodama.sqlite')};
}
async function snapshot(directory){
  const names=(await readdir(directory)).sort();
  return Promise.all(names.map(async name=>[name,digest(await readFile(path.join(directory,name)))]));
}
function rejectsLegacy(dataDir){
  assert.throws(()=>new Store(dataDir),{name:'Refused',code:'STORE_MIGRATION_REQUIRED',message:'STORE_MIGRATION_REQUIRED'});
}

for(const table of ['analysis_records','analysis_usage','external_submissions','meeting_jobs','meeting_delivery_attempts']){
  test(`legacy ${table} refuses startup before journal, DDL or task recovery changes`,async t=>{
    const {dataDir,filename}=await fixture(t),db=new DatabaseSync(filename);
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,state TEXT,body TEXT); INSERT INTO tasks VALUES('fixture','running','private fixture body');`);
    db.close();const before=await snapshot(dataDir);
    rejectsLegacy(dataDir);assert.deepEqual(await snapshot(dataDir),before);
    const readback=new DatabaseSync(filename,{readOnly:true});
    try{
      assert.equal(readback.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
      assert.equal(readback.prepare('SELECT state FROM tasks').get().state,'running');
      assert.equal(readback.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,2);
    }finally{readback.close();}
  });
}

for(const state of ['paused','future_state',null]){
  test(`unsupported Task state ${String(state)} is refused without changing stored contents`,async t=>{
    const {dataDir,filename}=await fixture(t),db=new DatabaseSync(filename);
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,state TEXT,body TEXT)');
    db.prepare('INSERT INTO tasks VALUES(?,?,?)').run('fixture',state,'private fixture body');
    db.close();const before=await snapshot(dataDir);
    rejectsLegacy(dataDir);assert.deepEqual(await snapshot(dataDir),before);
  });
}

test('legacy markers in an uncheckpointed WAL are detected without changing database or WAL bytes',async t=>{
  const {dataDir,filename}=await fixture(t),db=new DatabaseSync(filename);
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture_seed(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); CREATE TABLE meeting_jobs(id TEXT PRIMARY KEY,body TEXT);');
    const before=await Promise.all([filename,filename+'-wal'].map(async file=>digest(await readFile(file))));
    rejectsLegacy(dataDir);
    assert.deepEqual(await Promise.all([filename,filename+'-wal'].map(async file=>digest(await readFile(file)))),before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n,2);
  }finally{db.close();}
});

test('closed WAL legacy data is unchanged even when SQLite creates read-side coordination files',async t=>{
  const {dataDir,filename}=await fixture(t),db=new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE meeting_jobs(id TEXT PRIMARY KEY,body TEXT)');db.close();
  const before=digest(await readFile(filename));rejectsLegacy(dataDir);
  assert.equal(digest(await readFile(filename)),before);
  const names=await readdir(dataDir);
  assert(names.every(name=>['kotodama.sqlite','kotodama.sqlite-wal','kotodama.sqlite-shm'].includes(name)));
  // A read-only SQLite connection may create WAL coordination files, but no data frames.
  if(names.includes('kotodama.sqlite-wal'))assert.equal((await readFile(filename+'-wal')).length,0);
});

test('runtime refuses legacy data before taking a host lock or reconciling a running task',async t=>{
  const {root,dataDir}=await fixture(t),config=exampleConfig({workspace:root});config.dataDir=dataDir;
  const store=new Store(dataDir),key=store.ingest(source('legacy-running')).key,task=store.createTask(store.source(key,actor),intent);
  store.claim(task.id,task.revision);store.claimHost('fixture-old-owner',2147483647,'2026-01-01T00:00:00.000Z','fixture-runtime');
  store.db.exec('CREATE TABLE analysis_records(id TEXT PRIMARY KEY,body TEXT); PRAGMA journal_mode=DELETE;');store.close();
  const file=path.join(root,'config.json');await writeFile(file,JSON.stringify(config));const before=await snapshot(dataDir);
  await assert.rejects(startRuntime(file,{offline:true,runtimeDomain:'fixture-runtime',log:()=>{}}),{code:'STORE_MIGRATION_REQUIRED'});
  assert.deepEqual(await snapshot(dataDir),before);
});

test('all public Task states and extension tables reopen and retain public recovery semantics',async t=>{
  const {root,dataDir}=await fixture(t),store=new Store(dataDir),ids={};
  for(const state of ['queued','running','stopping','cancelled','failed','uncertain','needs_review','stale']){
    const item=source(state),key=store.ingest(item).key,task=store.createTask(store.source(key,actor),intent);ids[state]=task.id;
    if(['running','stopping','failed','uncertain','needs_review'].includes(state))store.claim(task.id,task.revision);
    if(['stopping','cancelled'].includes(state))store.cancel(task.id,actor);
    if(['failed','uncertain','needs_review'].includes(state))store.finish(task.id,task.revision,{state,summary:'Synthetic result',artifacts:[]});
    if(state==='stale')store.ingest({...item,revision:2,text:'Corrected synthetic request'});
    assert.equal(store.taskInternal(task.id).state,state);
  }
  const notifications=new NotificationQueue(store.db,()=>({enabled:false}));notifications.defer('fixture-notice','task',{id:ids.needs_review,actor});
  store.db.exec("CREATE TABLE fixture_extension(value TEXT); INSERT INTO fixture_extension VALUES('preserve');");
  store.claimDelivery('fixture-unknown','Synthetic unknown delivery');store.claimDelivery('fixture-sent','Synthetic sent delivery');store.delivered('fixture-sent','fixture-message');
  store.reserveAudio(250,1);store.setVoiceSuspension('fixture-guild','fixture-channel','pause');
  store.recordConsent({guild:'fixture-guild',channel:'fixture-channel',actor,notice:'fixture-notice',granted:true,interactionId:'100000000000000099'});
  store.close();
  const reopened=new Store(dataDir);
  try{
    for(const [state,id] of Object.entries(ids))assert.equal(reopened.taskInternal(id).state,state);
    assert.equal(reopened.deliveryState('fixture-unknown'),'unknown');assert.equal(reopened.claimDelivery('fixture-unknown','Synthetic unknown delivery'),false);
    assert.equal(reopened.deliveryState('fixture-sent'),'sent');assert.equal(reopened.voiceSuspension('fixture-guild','fixture-channel'),'pause');
    assert.equal(reopened.consent('fixture-guild','fixture-channel',actor,'fixture-notice'),true);assert.equal(reopened.reserveAudio(250,1),500);
    assert.equal(reopened.db.prepare('SELECT state FROM deferred_notifications').get().state,'pending');
    assert.equal(reopened.db.prepare('SELECT value FROM fixture_extension').get().value,'preserve');
  }finally{reopened.close();}
  const config=exampleConfig({workspace:root});config.dataDir=dataDir;const file=path.join(root,'config.json');await writeFile(file,JSON.stringify(config));let executions=0;
  const runtime=await startRuntime(file,{offline:true,analyzer:{analyze:async()=>{executions++;throw Error('unexpected analysis');}},worker:{run:async()=>{executions++;throw Error('unexpected execution');}},log:()=>{}});
  try{
    for(const [state,id] of Object.entries(ids))assert.equal(runtime.store.taskInternal(id).state,['running','stopping'].includes(state)?'uncertain':state);
    assert.equal(runtime.store.deliveryState('fixture-unknown'),'unknown');
    assert.equal(runtime.store.db.prepare('SELECT state FROM deferred_notifications').get().state,'pending');
    assert.equal(executions,0);
  }finally{await runtime.close();}
});

test('older public consent and lock columns still receive their supported additive upgrades',async t=>{
  const {dataDir,filename}=await fixture(t),db=new DatabaseSync(filename);
  db.exec('CREATE TABLE voice_consents(guild TEXT NOT NULL,channel TEXT NOT NULL,actor TEXT NOT NULL,notice TEXT NOT NULL,granted INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(guild,channel,actor)); CREATE TABLE host_lock(name TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,created TEXT NOT NULL);');
  db.prepare('INSERT INTO voice_consents VALUES(?,?,?,?,?,?)').run('fixture-guild','fixture-channel',actor,'fixture-notice',1,'2026-01-01');db.close();
  const store=new Store(dataDir);
  try{
    assert.equal(store.consent('fixture-guild','fixture-channel',actor,'fixture-notice'),true);
    assert.equal(store.db.prepare('SELECT interaction_id FROM voice_consents').get().interaction_id,'0');
    assert(store.db.prepare('PRAGMA table_info(host_lock)').all().some(column=>column.name==='domain'));
  }finally{store.close();}
});

import {Analysis,modelExecution} from './llm.mjs';
import {check,digest,errorCode} from './common.mjs';
import {verifyArtifacts} from './worker.mjs';

export class Pipeline {
  constructor({store,owner=store,config,analyzer,worker,authorize=async()=>{},onTask=async()=>{},onReply=async()=>{},onVoiceAction=async()=>{},onError=()=>{}}){
    Object.assign(this,{store,owner,config,analyzer,worker,authorize,onTask,onReply,onVoiceAction,onError});this.active=new Map();this.queued=new Set();this.tail=Promise.resolve();this.analysis=new Map();this.analysisControllers=new Map();this.analysisBindings=new Map();this.closing=false;
  }
  context(source,principal){
    const config=this.config.analyzer,maxSources=config.maxContextSources??12;let remaining=config.maxContextChars??24000;
    const result=[],time=s=>Date.parse(s.metadata?.createdAt??'')||0;
    const room=this.store.sources(principal).filter(s=>s.guildId===source.guildId&&s.channelId===source.channelId&&s.key!==source.key);
    const archived=new Set(room.filter(s=>s.metadata?.kind==='archived_voice').map(s=>s.metadata.sessionId));
    const candidates=room.filter(s=>{const refs=s.metadata?.archiveSessionRefs;return !refs?.length||!refs.every(id=>archived.has(id));}).sort((a,b)=>time(a)-time(b)||a.revision-b.revision||a.key.localeCompare(b.key)).slice(-maxSources).reverse();
    for(const s of candidates){if(remaining<=0)break;const text=s.text.slice(0,Math.min(12000,remaining));remaining-=text.length;result.unshift({key:s.key,revision:s.revision,text,actorId:s.actorId});}return result;
  }
  async ingest(source,{execute=false,reply=false,analyze=true}={}){
    check(!this.closing,'RUNTIME_STOPPING');if(this.owner.kind==='remote')await this.owner.ingest(source);
    const received=this.store.ingest(source);
    if(received.state==='corrected')for(const [id,run] of this.active)if(run.sourceKey===received.key||run.sourceKeys?.has(received.key))run.controller.abort();
    if(received.state==='corrected')for(const [id,bindings]of this.analysisBindings)if(bindings.some(b=>b.key===received.key))this.analysisControllers.get(id)?.abort();
    if(['duplicate','stale'].includes(received.state)||!source.final||source.withdrawn)return received;
    if(!analyze)return {...received,analysis:'recorded_only'};
    const principal=source.readers.includes(source.actorId)?source.actorId:source.readers.find(p=>this.config.discord.operators.includes(p));
    if(!principal)return {...received,analysis:'no_authorized_reader'};
    const key=digest([received.key,source.revision]);if(this.analysis.has(key))return this.analysis.get(key);
    const job=this.#analyze({...source,key:received.key},principal,{execute,reply},key).finally(()=>{this.analysis.delete(key);this.analysisControllers.delete(key);this.analysisBindings.delete(key);});
    this.analysis.set(key,job);return job;
  }
  async #analyze(source,principal,{execute,reply},analysisKey){
    const controller=new AbortController();this.analysisControllers.set(analysisKey,controller);
    const analyzerConfig=this.config.analyzer;let taskChars=analyzerConfig.maxTaskContextChars??12000;const tasksContext=[];for(const task of (await this.owner.tasks(principal)).filter(t=>t.room===`${source.provider}:${source.guildId}:${source.channelId}`).slice(0,analyzerConfig.maxTaskContextItems??5)){if(taskChars<=0)break;const request=task.request.slice(0,taskChars);taskChars-=request.length;tasksContext.push({...task,request});}
    const context=this.context(source,principal);const bindings=[source,...context].map(s=>({key:s.key,revision:s.revision}));this.analysisBindings.set(analysisKey,bindings);
    const analyzed=await this.analyzer.analyze(source,context,{signal:controller.signal,tasks:tasksContext});const result=Analysis.parse(analyzed);check(!controller.signal.aborted&&!this.closing,'CANCELLED');
    if(modelExecution(analyzed))this.store.event('analysis.model_used',{source_key:source.key,revision:source.revision,...modelExecution(analyzed)});
    const checkInputs=()=>{for(const b of bindings){const s=this.store.source(b.key,principal);check(s.revision===b.revision,'CONTEXT_CHANGED');}};checkInputs();
    const current=this.store.source(source.key,principal);check(current.revision===source.revision,'SOURCE_CHANGED');
    const ids=this.store.saveIntents(source,result.intents.map(i=>({...i,contextSources:bindings})),principal);const tasks=[];
    let requests=result.intents.map((intent,index)=>({intent,index})).filter(({intent})=>execute&&!this.draining&&source.provider==='discord'&&this.config.discord.operators.includes(source.actorId)&&intent.kind==='request'&&intent.explicit&&intent.complete&&intent.action!=='none');
    for(const {intent} of requests)check(this.config.worker.actions.includes(intent.action),'ACTION_NOT_ALLOWED');
    // One installation has one write workspace. Related edits from one message
    // share a candidate so verification sees the combined change.
    const writes=requests.filter(({intent})=>!intent.targetTaskId&&['develop','write_file'].includes(intent.action));
    if(writes.length>1){const first=writes[0],indexes=new Set(writes.map(r=>r.index));const combined={...first.intent,title:writes.map(r=>r.intent.title).join(' / ').slice(0,300),request:writes.map(r=>r.intent.request).join('\n\n'),action:writes.some(r=>r.intent.action==='develop')?'develop':'write_file',acceptance:[...new Set(writes.flatMap(r=>r.intent.acceptance))],intentIds:writes.map(r=>ids[r.index]),requiredActions:[...new Set(writes.map(r=>r.intent.action))]};check(combined.request.length<=16000,'REQUEST_GROUP_LIMIT');requests=requests.filter(r=>!indexes.has(r.index)||r===first).map(r=>r===first?{index:first.index,intent:combined}:r);}
    for(const {index,intent} of requests){
      if(intent.targetTaskId){const prior=await this.owner.task(intent.targetTaskId,source.actorId);check(prior.room===`${source.provider}:${source.guildId}:${source.channelId}`,'TASK_ROOM_MISMATCH');await this.authorize(prior,'revise');}
      checkInputs();const boundIntent={...intent,intentIds:intent.intentIds??[ids[index]],requiredActions:intent.requiredActions??[intent.action],contextSources:bindings};const task=intent.targetTaskId?await this.owner.reviseTask(intent.targetTaskId,source,boundIntent):await this.owner.createTask(source,{...boundIntent,key:ids[index]});await this.authorize(task);
      if(intent.targetTaskId)this.active.get(intent.targetTaskId)?.controller.abort();tasks.push(task.id);this.enqueue(task.id,task.actor,task.revision);
    }
    if(source.metadata?.kind==='voice'&&!source.metadata.nativeConversation&&result.voiceAction!=='none'){checkInputs();await this.onVoiceAction({source,action:result.voiceAction,contextSources:bindings});}
    else if(reply&&result.replyRequested){checkInputs();await this.onReply({source,text:result.reply,contextSources:bindings});}
    return {key:source.key,state:'analyzed',intents:ids,tasks,summary:result.summary,answer:result.replyRequested?result.reply:null,contextSources:bindings};
  }
  async request(source,{title,request,action,acceptance=[]}){
    check(!this.closing&&!this.draining,'RUNTIME_STOPPING');
    check(source.provider==='discord'&&this.config.discord.operators.includes(source.actorId),'OPERATOR_REQUIRED');
    check(this.config.worker.actions.includes(action),'ACTION_NOT_ALLOWED');
    source={...source,metadata:{...source.metadata,command:{title,request,action,acceptance}}};
    if(this.owner.kind==='remote')await this.owner.ingest({...source,final:true});const received=this.store.ingest({...source,final:true});const s=this.store.source(received.key,source.actorId);
    const intentIds=this.store.saveIntents(s,[{kind:'request',title,request,action,acceptance,explicit:true,complete:true,origin:'explicit_command',contextSources:[{key:s.key,revision:s.revision}]}],source.actorId);const task=await this.owner.createTask(s,{title,request,action,acceptance,key:'explicit-command',intentIds,requiredActions:[action]});await this.authorize(task);this.enqueue(task.id,source.actorId,task.revision);return task;
  }
  enqueue(id,actor,revision){const key=id+':'+revision;if(this.queued.has(key))return;this.queued.add(key);this.tail=this.tail.then(()=>this.#execute(id,actor,revision)).catch(e=>this.onError(errorCode(e))).finally(()=>this.queued.delete(key));}
  async #execute(id,actor,revision){
    const task=await this.owner.task(id,actor);if(task.state!=='queued'||task.revision!==revision||this.closing||this.draining)return;
    await this.authorize(task);await this.owner.claim(id,task.revision);
    const controller=new AbortController();const active={revision:task.revision,sourceKey:task.source_key,sourceKeys:new Set([task.source_key]),controller};this.active.set(id,active);
    const authorize=async()=>{check(!controller.signal.aborted,'CANCELLED');const latest=await this.owner.task(id,actor);check(latest.revision===task.revision&&latest.state==='running','TASK_CHANGED');const source=this.store.source(task.source_key,actor);check(source.revision===task.source_revision,'SOURCE_CHANGED');await this.owner.assertContext(id,actor);await this.authorize(latest);};
    try{
      const source=this.store.source(task.source_key,actor);const context=[source,...this.context(source,actor)];const bindings=context.map(s=>({key:s.key,revision:s.revision}));await this.owner.bindContext(id,task.revision,bindings);active.sourceKeys=new Set(bindings.map(s=>s.key));
      const result=await this.worker.run({...task,contextSources:bindings},context,{signal:controller.signal,authorize,onStart:p=>this.store.event('worker.started',p,id)});
      await authorize();await this.owner.finish(id,task.revision,result);await this.onTask(await this.owner.task(id,actor));
    }catch(e){
      const current=await this.owner.taskInternal(id);if(current.state==='stopping')try{await this.owner.confirmStop(id,actor,errorCode(e)==='CANCELLED');}catch{}
      else if(current.state==='running')try{await this.owner.finish(id,task.revision,{state:errorCode(e)==='STOP_UNCONFIRMED'?'uncertain':'failed',summary:errorCode(e),artifacts:[]});}catch{}
      this.onError(errorCode(e));
    }finally{this.active.delete(id);}
  }
  async stop(id,actor){await this.owner.cancel(id,actor);this.active.get(id)?.controller.abort();}
  async resume(id,actor){check(!this.active.has(id),'STOP_NOT_FINISHED');const t=await this.owner.resume(id,actor);await this.authorize(t);this.enqueue(id,actor,t.revision);return t;}
  async result(id,actor){const task=await this.owner.task(id,actor);await this.authorize(task,'read_result');return verifyArtifacts(task);}
  async close(){this.closing=true;for(const c of this.analysisControllers.values())c.abort();for(const run of this.active.values())run.controller.abort();await Promise.allSettled([...this.analysis.values()]);await this.tail;}
}

import path from 'node:path';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {mkdir,lstat,readFile} from 'node:fs/promises';
import {workerEnv} from './command.mjs';
import {atomicJson,check,digest,Refused,safePath} from './common.mjs';

// No shell, websocket listener, credential copying, or automatic auth fallback.
// This is a client of Codex's harness, not a second planning/execution loop.
export const executionPolicy=(cwd,write)=>write
  ?{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}
  :{type:'readOnly',networkAccess:false};

function protocolFailure(error){
  const text=String(error?.message??'');
  if(/auth|login|unauthorized|access token/i.test(text))return new Refused('CODEX_LOGIN_REQUIRED');
  if(/usage limit|quota|rate limit/i.test(text))return new Refused('MODEL_USAGE_LIMIT');
  return new Refused('CODEX_PROTOCOL_FAILED');
}

export class CodexAppServer {
  constructor(config,{dataDir,cwd,onStart=()=>{},maxBytes=8000000}={}){
    Object.assign(this,{config,dataDir,cwd,onStart,maxBytes});this.pending=new Map();this.listeners=new Set();this.nextId=1;this.failure=null;this.closed=false;
  }
  async start(){
    const cfg=this.config;check(process.platform!=='win32','APP_SERVER_REQUIRES_POSIX_OWNER');
    check(!cfg.fallback,'WORKER_FALLBACK_REMOVED');
    check(!(cfg.apiKeyEnv&&cfg.codexHome),'APP_SERVER_API_HOME_MUST_BE_ISOLATED');
    const home=cfg.codexHome??path.join(this.dataDir,'codex-app-server');await mkdir(home,{recursive:true,mode:0o700});
    check(!(await lstat(home)).isSymbolicLink(),'LINK_PATH_REFUSED');
    // Unlike codex exec, app-server has no --ignore-user-config flag.
    // Do not silently load a user config when its omission was requested.
    if(cfg.ignoreUserConfig!==false){
      try{await lstat(path.join(home,'config.toml'));throw new Refused('APP_SERVER_USER_CONFIG_PRESENT');}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    const args=[...(cfg.args??[]),'-c','model_provider="openai"','-c','approval_policy="never"','-c','sandbox_mode="read-only"',
      '--disable','apps','--disable','plugins','--disable','hooks','--disable','image_generation','--enable','multi_agent','-c','web_search="disabled"'];
    if(cfg.apiKeyEnv)args.push('-c','cli_auth_credentials_store="ephemeral"','-c','forced_login_method="api"');
    else args.push('-c','forced_login_method="chatgpt"');
    args.push('app-server','--stdio');
    const env=workerEnv({CODEX_HOME:home});
    this.child=spawn(cfg.executable,args,{cwd:this.cwd,env,stdio:['pipe','pipe','pipe'],detached:true,windowsHide:true});
    const child=this.child,decoder=new StringDecoder('utf8');let buffer='',bytes=0;
    this.exit=new Promise(resolve=>child.once('close',(code,signal)=>{this.closed=true;this.fail(new Refused('CODEX_CONNECTION_LOST'));resolve({code,signal});}));
    child.once('error',()=>this.fail(new Refused('COMMAND_UNAVAILABLE')));
    child.once('spawn',()=>{try{this.onStart({pid:child.pid,createdAt:new Date().toISOString(),groupOwned:true,adapter:'codex_app_server'});}catch{this.fail(new Refused('START_OBSERVER_FAILED'));}});
    const consume=chunk=>{bytes+=chunk.length;if(bytes>this.maxBytes){this.fail(new Refused('COMMAND_OUTPUT_LIMIT'));return false;}return true;};
    child.stderr.on('data',consume); // Never expose transport output or login payloads.
    child.stdout.on('data',chunk=>{
      if(!consume(chunk))return;buffer+=decoder.write(chunk);let newline;
      while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
        let message;try{message=JSON.parse(line);}catch{this.fail(new Refused('CODEX_PROTOCOL_INVALID'));return;}
        if(message.method&&Object.hasOwn(message,'id')){
          // This unattended adapter never grants a new permission or answers as a user.
          try{this.send({id:message.id,error:{code:-32601,message:'Interactive approval is not available in this worker'}});}catch{}
          for(const listener of this.listeners)listener({method:'client/approvalRequired',params:{}});
        }else if(Object.hasOwn(message,'id')){
          const pending=this.pending.get(message.id);if(pending){this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(protocolFailure(message.error)):pending.resolve(message.result);}
        }else if(message.method){for(const listener of this.listeners)listener(message);}
      }
    });
    child.stdin.on('error',()=>this.fail(new Refused('CODEX_CONNECTION_LOST')));
    try{
      await this.request('initialize',{clientInfo:{name:'kotodama-discord',title:'Kotodama Discord',version:'0.1.0'}});
      this.send({method:'initialized',params:{}});
      if(cfg.apiKeyEnv){
        const apiKey=process.env[cfg.apiKeyEnv];check(apiKey,'OPENAI_CREDENTIAL_REQUIRED');
        await this.request('account/login/start',{type:'apiKey',apiKey});
      }
      const auth=await this.request('account/read',{refreshToken:false});
      check(auth?.account?.type===(cfg.apiKeyEnv?'apiKey':'chatgpt'),'CODEX_LOGIN_REQUIRED');
      this.authMode=auth.account.type;return this;
    }catch(error){await this.close();throw error;}
  }
  send(message){
    check(!this.closed&&!this.failure,'CODEX_CONNECTION_LOST');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  request(method,params,{timeoutMs=15000}={}){
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{
      const id=this.nextId++,timer=setTimeout(()=>{this.pending.delete(id);reject(new Refused('CODEX_REQUEST_TIMEOUT'));},timeoutMs);timer.unref();
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  fail(error){
    if(this.failure)return;this.failure=error;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    for(const listener of this.listeners)listener({method:'client/failure',params:{error}});
  }
  async close(){
    if(!this.child)return;
    const child=this.child,alive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
    const kill=signal=>{if(!child.pid)return;try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw new Refused('STOP_UNCONFIRMED');}};
    if(!this.closed)child.stdin.end();
    if(!this.closed)await Promise.race([this.exit,new Promise(r=>setTimeout(r,150))]);
    if(alive())kill('SIGTERM');
    let until=Date.now()+500;while(alive()&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
    if(alive())kill('SIGKILL');
    until=Date.now()+2500;while(alive()&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
    check(!alive(),'STOP_UNCONFIRMED');
    this.fail(new Refused('CODEX_CONNECTION_LOST'));
  }
}

export async function executionBinding(config,task){
  check(/^[A-Za-z0-9_-]+$/.test(task.id)&&Number.isSafeInteger(task.revision)&&task.revision>0,'TASK_EXECUTION_ID_INVALID');
  await mkdir(path.join(config.dataDir,'executions'),{recursive:true,mode:0o700});
  const file=await safePath(config.dataDir,`executions/${task.id}.json`,{mustExist:false});
  let binding=null;try{
    const stat=await lstat(file);check(stat.isFile()&&stat.nlink===1&&stat.size<64000,'EXECUTION_BINDING_INVALID');binding=JSON.parse(await readFile(file,'utf8'));
  }catch(e){if(e.code!=='ENOENT')throw e;}
  if(binding)check(binding.version===1&&binding.taskId===task.id&&binding.actor===task.actor&&binding.room===task.room&&binding.installation===config.installation&&binding.sourceWorkspace===config.worker.workspace,'EXECUTION_BINDING_MISMATCH');
  return {file,binding};
}

export class CodexTaskExecution {
  constructor(config,task,{file,binding,cwd,baseRevision,write,signal,onStart,authorize=async()=>{}}){
    Object.assign(this,{config,task,file,cwd,write,signal,authorize});
    this.binding=binding??{version:1,installation:config.installation,taskId:task.id,actor:task.actor,room:task.room,sourceWorkspace:config.worker.workspace,workspace:cwd,baseRevision,phase:'ready',revision:0};
    if(write&&baseRevision)this.binding.baseRevision=baseRevision;
    this.server=new CodexAppServer(config.worker,{dataDir:config.dataDir,cwd,onStart});
  }
  async save(patch){Object.assign(this.binding,patch);await atomicJson(this.file,this.binding);}
  async start(){
    check(!this.signal?.aborted,'CANCELLED');await this.save({workspace:this.cwd});
    const abort=()=>this.server.fail(new Refused('CANCELLED'));this.signal?.addEventListener('abort',abort,{once:true});
    try{
      check(!this.signal?.aborted,'CANCELLED');await this.server.start();
      const options={cwd:this.cwd,approvalPolicy:'never',sandbox:this.write?'workspace-write':'read-only',...(this.config.worker.model?{model:this.config.worker.model}:{})};
      if(this.binding.threadId){
        const resumed=await this.server.request('thread/resume',{...options,threadId:this.binding.threadId,excludeTurns:true});
        check(resumed?.thread?.id===this.binding.threadId,'EXECUTION_THREAD_MISMATCH');
        // A lost response is not permission to resend. Reconcile only a known turn.
        if(['submitting','running','uncertain'].includes(this.binding.phase)){
          check(this.binding.turnId,'EXECUTION_RECONCILIATION_REQUIRED');
          let cursor,found;
          for(let page=0;page<10&&!found;page++){
            const turns=await this.server.request('thread/turns/list',{threadId:this.binding.threadId,limit:100,sortDirection:'desc',...(cursor?{cursor}:{})});
            found=turns?.data?.find(t=>t.id===this.binding.turnId);cursor=turns?.nextCursor;if(!cursor)break;
          }
          check(found&&['completed','failed','interrupted'].includes(found.status),'EXECUTION_RECONCILIATION_REQUIRED');
          await this.save({phase:found.status});
        }
        check(this.task.revision>this.binding.revision,'EXECUTION_REVISION_ALREADY_SENT');
      }else{
        const started=await this.server.request('thread/start',{...options,ephemeral:false});check(started?.thread?.id,'EXECUTION_THREAD_MISSING');
        await this.save({threadId:started.thread.id});
      }
      await this.save({workspace:this.cwd});return this;
    }catch(error){await this.server.close();throw error;}
    finally{this.signal?.removeEventListener('abort',abort);}
  }
  async run(prompt,schema,decode){
    await this.authorize();check(!this.signal?.aborted,'CANCELLED');
    const server=this.server,threadId=this.binding.threadId;
    let turnId,answer=null,terminal=null,aborted=false;
    const messages=new Map(),finished=new Map();let resolveEvent,rejectEvent;
    const completion=new Promise((resolve,reject)=>{resolveEvent=resolve;rejectEvent=reject;});
    // A listener must be attached before submitting: notifications can precede the response.
    const listener=event=>{
      const p=event.params??{};
      if(event.method==='client/failure'){rejectEvent(p.error);return;}
      if(event.method==='client/approvalRequired'){rejectEvent(new Refused('WORKER_INPUT_REQUIRED'));return;}
      if(p.threadId!==threadId)return;
      if(event.method==='item/completed'&&p.item?.type==='agentMessage')messages.set(p.turnId,p.item.text);
      if(event.method==='turn/completed'){finished.set(p.turn?.id,p.turn);if(p.turn?.id===turnId)resolveEvent(p.turn);}
    };
    server.listeners.add(listener);completion.catch(()=>{});
    const stop=()=>{aborted=true;if(turnId)server.request('turn/interrupt',{threadId,turnId},{timeoutMs:1000}).catch(()=>{});else server.fail(new Refused('CANCELLED'));rejectEvent(new Refused('CANCELLED'));};
    this.signal?.addEventListener('abort',stop,{once:true});
    const timeout=setTimeout(()=>rejectEvent(new Refused('COMMAND_TIMEOUT')),this.config.worker.timeoutSeconds*1000);timeout.unref();
    try{
      await this.save({phase:'submitting',revision:this.task.revision,turnId:null,inputSha256:digest(prompt)});
      const response=await server.request('turn/start',{threadId,input:[{type:'text',text:prompt}],cwd:this.cwd,approvalPolicy:'never',sandboxPolicy:executionPolicy(this.cwd,this.write),outputSchema:schema,...(this.config.worker.model?{model:this.config.worker.model}:{})});
      turnId=response?.turn?.id;check(turnId,'EXECUTION_TURN_MISSING');await this.save({phase:'running',turnId});
      if(aborted||this.signal?.aborted)stop();
      if(finished.has(turnId))resolveEvent(finished.get(turnId));
      terminal=await completion;await this.save({phase:terminal.status});
      check(terminal.status==='completed',terminal.status==='interrupted'?'CANCELLED':'MODEL_COMMAND_FAILED');
      answer=messages.get(turnId);check(typeof answer==='string','MODEL_RESULT_MISSING');
      return {value:decode(answer),execution:{adapter:'codex_app_server',model:this.config.worker.model??null,authMode:server.authMode,threadId,turnId,fallback:false}};
    }catch(error){
      if(turnId&&!terminal){
        try{await server.request('turn/interrupt',{threadId,turnId},{timeoutMs:1000});}catch{}
        // A request ACK alone does not establish that the turn stopped.
        terminal=finished.get(turnId);
      }
      await this.save({phase:terminal?.status??'uncertain'});throw error;
    }finally{clearTimeout(timeout);this.signal?.removeEventListener('abort',stop);server.listeners.delete(listener);}
  }
  async verify(command){
    await this.authorize();check(!this.signal?.aborted,'CANCELLED');
    const processId=`verify-${this.task.revision}-${Date.now()}`;
    let rejectCancelled;const cancelled=new Promise((_,reject)=>{rejectCancelled=reject;});cancelled.catch(()=>{});
    const stop=()=>{this.server.request('command/exec/terminate',{processId},{timeoutMs:1000}).catch(()=>{});rejectCancelled(new Refused('CANCELLED'));};
    this.signal?.addEventListener('abort',stop,{once:true});
    try{
      check(!this.signal?.aborted,'CANCELLED');
      const r=await Promise.race([this.server.request('command/exec',{command:[command.executable,...command.args],cwd:this.cwd,sandboxPolicy:executionPolicy(this.cwd,true),timeoutMs:this.config.worker.timeoutSeconds*1000,processId,outputBytesCap:1000000},{timeoutMs:this.config.worker.timeoutSeconds*1000+2000}),cancelled]);
      check(!this.signal?.aborted,'CANCELLED');check(Number.isInteger(r?.exitCode)&&typeof r.stdout==='string'&&typeof r.stderr==='string','VALIDATION_RESULT_INVALID');
      return {command:command.executable,exitCode:r.exitCode,outputSha256:digest(r.stdout+r.stderr),adapter:'codex_app_server',sandbox:'workspace-write',networkAccess:false};
    }finally{this.signal?.removeEventListener('abort',stop);}
  }
  async close(){await this.server.close();}
}

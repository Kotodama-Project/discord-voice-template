import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {exampleConfig} from '../src/config.mjs';
import {CliWorker} from '../src/worker.mjs';
import {CodexAppServer,executionBinding} from '../src/codex-app-server.mjs';
import {runCommand} from '../src/command.mjs';
import {resultFiles} from '../src/result-files.mjs';
import {DiscordAdapter} from '../src/discord.mjs';

const fixtureCli=fileURLToPath(new URL('./fixtures/app-server.mjs',import.meta.url));
async function fixture(t,{args=[],write=false,api=false}={}){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ktdm-appserver-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=exampleConfig({workspace:root});config.dataDir=path.join(root,'data');
  config.worker={...config.worker,kind:'codex_app_server',executable:process.execPath,args:[fixtureCli,...args],timeoutSeconds:5,actions:[write?'develop':'research'],verify:[]};
  if(!api){delete config.worker.apiKeyEnv;config.worker.codexHome=path.join(config.dataDir,'codex-app-server');}
  if(api){config.worker.apiKeyEnv='KOTODAMA_APP_SERVER_TEST_KEY';const prior=process.env.KOTODAMA_APP_SERVER_TEST_KEY;process.env.KOTODAMA_APP_SERVER_TEST_KEY='synthetic';t.after(()=>{if(prior===undefined)delete process.env.KOTODAMA_APP_SERVER_TEST_KEY;else process.env.KOTODAMA_APP_SERVER_TEST_KEY=prior;});}
  if(write)for(const args of [['init'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture']])assert.equal((await runCommand('git',args,{cwd:root})).code,0);
  const task={id:'task-fixture',actor:'100000000000000002',room:'discord:fixture:fixture',revision:1,source_revision:1,action:write?'develop':'research',request:'synthetic request',acceptance:[]};
  const state=async()=>JSON.parse(await readFile(path.join(config.dataDir,'codex-app-server','fixture-state.json'),'utf8'));
  return {root,config,task,state,worker:new CliWorker(config)};
}

test('App Server writes and verifies in its sandbox; correction resumes the same task thread/worktree',{skip:process.platform==='win32'},async t=>{
  const {root,config,task,state,worker}=await fixture(t,{write:true});
  const outside=path.join(root,'host-must-not-run');config.worker.verify=[{executable:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(outside)},'unsafe')`]}];
  const first=await worker.run(task,[]),second=await worker.run({...task,revision:2,source_revision:2,request:'corrected'},[]);
  assert.equal(first.state,'needs_review');assert.equal(second.workspace,first.workspace);assert.equal(first.modelExecution.threadId,second.modelExecution.threadId);
  assert.equal(await readFile(first.artifacts.find(a=>a.relative==='created.mjs').path,'utf8'),'export const answer = 1;\n');
  assert.equal(await readFile(second.artifacts.find(a=>a.relative==='created.mjs').path,'utf8'),'export const answer = 2;\n');
  assert.notEqual(first.modelExecution.turnId,second.modelExecution.turnId);assert.equal(first.validations[0].adapter,'codex_app_server');
  await assert.rejects(readFile(outside),{code:'ENOENT'});const log=await state();assert.equal(log.threads.length,1);assert.equal(log.threads[0].turns.length,2);
  const commands=log.calls.filter(c=>c.method==='command/exec');assert.equal(commands.length,2);
  for(const {params} of commands){assert.equal(params.sandboxPolicy.type,'workspaceWrite');assert.equal(params.sandboxPolicy.networkAccess,false);assert.deepEqual(params.sandboxPolicy.writableRoots,[first.workspace]);assert.equal(params.sandboxPolicy.excludeSlashTmp,true);}
  const start=log.calls.find(c=>c.method==='turn/start');assert.equal(start.params.approvalPolicy,'never');assert.equal(start.args[start.args.indexOf('multi_agent')-1],'--enable');
  await assert.rejects(worker.run({...task,revision:2},[]),{code:'EXECUTION_REVISION_ALREADY_SENT'});
  assert.equal((await state()).threads[0].turns.length,2);
});

test('API authentication is explicit, ephemeral, and never inherited by generated commands',{skip:process.platform==='win32'},async t=>{
  const {config,task,state,worker}=await fixture(t,{api:true});await worker.run(task,[]);const log=await state();
  assert(log.calls.some(c=>c.method==='account/login/start'&&c.params.type==='apiKey'&&c.params.hasKey));
  assert(log.calls[0].args.includes('cli_auth_credentials_store="ephemeral"'));assert(log.calls[0].args.includes('forced_login_method="api"'));
  assert(log.calls.every(c=>!c.hasInheritedKey));assert(!JSON.stringify(log).includes('synthetic"'));await assert.rejects(readFile(path.join(config.dataDir,'codex-app-server','auth.json')),{code:'ENOENT'});
});

test('requested API auth cannot silently use a subscription account',{skip:process.platform==='win32'},async t=>{
  const {task,state,worker}=await fixture(t,{api:true,args:['--fixture-wrong-auth']});await assert.rejects(worker.run(task,[]),{code:'CODEX_LOGIN_REQUIRED'});assert(!(await state()).calls.some(c=>c.method==='turn/start'));
});

test('subscription mode rejects a saved API key before submitting a model turn',{skip:process.platform==='win32'},async t=>{
  const {task,state,worker}=await fixture(t,{args:['--fixture-saved-api-auth']});await assert.rejects(worker.run(task,[]),{code:'CODEX_LOGIN_REQUIRED'});
  const log=await state();assert(log.calls[0].args.includes('forced_login_method="chatgpt"'));assert(!log.calls.some(c=>c.method==='turn/start'||c.method==='account/login/start'));
});

test('write, read-only review, and later write revisions retain the candidate and thread',{skip:process.platform==='win32'},async t=>{
  const {config,task,state,worker}=await fixture(t,{write:true});config.worker.actions=['develop','research'];
  const first=await worker.run(task,[]),review=await worker.run({...task,revision:2,action:'research'},[]),last=await worker.run({...task,revision:3},[]);
  assert.equal(review.workspace,first.workspace);assert.equal(last.workspace,first.workspace);assert.equal(last.modelExecution.threadId,first.modelExecution.threadId);
  const turns=(await state()).calls.filter(c=>c.method==='turn/start');assert.deepEqual(turns.map(c=>c.params.sandboxPolicy.type),['workspaceWrite','readOnly','workspaceWrite']);assert(turns.every(c=>c.params.cwd===first.workspace));
  assert.equal(await readFile(last.artifacts.find(a=>a.relative==='created.mjs').path,'utf8'),'export const answer = 3;\n');
});

test('worker snapshots deliver through automatic DM and result after a later correction',{skip:process.platform==='win32'},async t=>{
  const {config,task,worker}=await fixture(t,{write:true,args:['--fixture-deliverable']});
  const first=await worker.run(task,[]),second=await worker.run({...task,revision:2},[]),sent=[],replies=[];
  const adapter=new DiscordAdapter({config,store:{source:()=>({channelId:config.discord.resultChannelId}),claimDelivery:()=>true,delivered:()=>{}},pipeline:{authorize:async()=>{},result:async()=>first}});t.after(()=>adapter.client.destroy());
  adapter.verifiedInstallation=true;adapter.member=async()=>({});adapter.canRead=async()=>true;adapter.client.channels.fetch=async()=>({});adapter.client.users.fetch=async()=>({send:async value=>{sent.push(value);return {id:'fixture-message'};}});
  await adapter.deliver({...task,result:first});assert.equal(sent[0].files[0].attachment.toString(),'Report 1');
  await adapter.interaction({guildId:config.discord.guildId,commandName:'kotodama',user:{id:task.actor},isButton:()=>false,isChatInputCommand:()=>true,options:{getSubcommand:()=> 'result',getString:()=> task.id},deferReply:async()=>{},editReply:async value=>replies.push(value)});
  assert.equal(replies[0].files[0].attachment.toString(),'Report 1');assert.equal((await resultFiles(second,adapter.resultFileOptions(task.id)))[0].attachment.toString(),'Report 2');
});

test('a lost start response is not replayed and a new task revision cannot silently bypass it',{skip:process.platform==='win32'},async t=>{
  const {config,task,state,worker}=await fixture(t,{args:['--fixture-disconnect']});await assert.rejects(worker.run(task,[]),{code:'CODEX_CONNECTION_LOST'});
  config.worker.args=[fixtureCli];await assert.rejects(worker.run({...task,revision:2},[]),{code:'EXECUTION_RECONCILIATION_REQUIRED'});assert.equal((await state()).threads[0].turns.length,1);
});

test('cancellation interrupts the native turn and a later revision resumes it',{skip:process.platform==='win32'},async t=>{
  const {config,task,state,worker}=await fixture(t,{args:['--fixture-wait']});const controller=new AbortController();
  const pending=worker.run(task,[],{signal:controller.signal});
  for(let i=0;i<100;i++){try{if((await state()).calls.some(c=>c.method==='turn/start'))break;}catch{}await new Promise(r=>setTimeout(r,10));}
  controller.abort();await assert.rejects(pending,{code:'CANCELLED'});config.worker.args=[fixtureCli];
  const result=await worker.run({...task,revision:3},[]);assert.equal(result.state,'needs_review');const log=await state();assert.equal(log.threads.length,1);assert(log.calls.some(c=>c.method==='turn/interrupt'));
});

test('a known disconnected turn must be reconciled before a correction can proceed',{skip:process.platform==='win32'},async t=>{
  const {config,task,state,worker}=await fixture(t,{args:['--fixture-lost-end']});await assert.rejects(worker.run(task,[]),{code:'CODEX_CONNECTION_LOST'});
  const binding=(await executionBinding(config,task)).binding;assert.equal(binding.turnId,'turn-1');
  config.worker.args=[fixtureCli];await assert.rejects(worker.run({...task,revision:2},[]),{code:'EXECUTION_RECONCILIATION_REQUIRED'});
  const saved=await state();saved.threads[0].turns[0].status='interrupted';await writeFile(path.join(config.dataDir,'codex-app-server','fixture-state.json'),JSON.stringify(saved));
  const result=await worker.run({...task,revision:2},[]);assert.equal(result.modelExecution.threadId,binding.threadId);assert.equal((await state()).threads[0].turns.length,2);
});

test('cancellation during validation does not wait for its configured deadline',{skip:process.platform==='win32'},async t=>{
  const {config,task,state,worker}=await fixture(t,{args:['--fixture-verify-wait'],write:true});config.worker.verify=[{executable:'ignored',args:[]}];const controller=new AbortController();
  const pending=worker.run(task,[],{signal:controller.signal});
  for(let i=0;i<100;i++){try{if((await state()).calls.some(c=>c.method==='command/exec'))break;}catch{}await new Promise(r=>setTimeout(r,10));}
  const started=Date.now();controller.abort();await assert.rejects(pending,{code:'CANCELLED'});assert(Date.now()-started<2000);
});

test('authentication failure preserves the candidate workspace for a later authorized retry',{skip:process.platform==='win32'},async t=>{
  const {config,task,worker}=await fixture(t,{write:true,api:true,args:['--fixture-wrong-auth']});await assert.rejects(worker.run(task,[]),{code:'CODEX_LOGIN_REQUIRED'});
  const before=(await executionBinding(config,task)).binding;assert.equal(before.phase,'ready');config.worker.args=[fixtureCli];
  const result=await worker.run({...task,revision:2},[]);assert.equal(result.workspace,before.workspace);assert.equal(result.state,'needs_review');
});

test('failed turns, failed validation, and new approval requests never become successful results',{skip:process.platform==='win32'},async t=>{
  const failed=await fixture(t,{args:['--fixture-fail']});await assert.rejects(failed.worker.run(failed.task,[]),{code:'MODEL_COMMAND_FAILED'});
  const denied=await fixture(t,{args:['--fixture-approval']});await assert.rejects(denied.worker.run(denied.task,[]),{code:'WORKER_INPUT_REQUIRED'});
  const verified=await fixture(t,{args:['--fixture-verify-fail'],write:true});verified.config.worker.verify=[{executable:'ignored',args:[]}];assert.equal((await verified.worker.run(verified.task,[])).state,'failed');
});

test('saved mapping cannot be reused by another actor or source workspace',{skip:process.platform==='win32'},async t=>{
  const {config,task,worker}=await fixture(t);await worker.run(task,[]);
  await assert.rejects(executionBinding(config,{...task,actor:'100000000000000003'}),{code:'EXECUTION_BINDING_MISMATCH'});
  await assert.rejects(executionBinding({...config,worker:{...config.worker,workspace:'/different'}},task),{code:'EXECUTION_BINDING_MISMATCH'});
});

test('App Server refuses to silently load a user config and refuses API login into a personal home',{skip:process.platform==='win32'},async t=>{
  const {root,config}=await fixture(t);const home=path.join(root,'home');await mkdir(home);await writeFile(path.join(home,'config.toml'),'');
  await assert.rejects(new CodexAppServer({...config.worker,codexHome:home},{dataDir:config.dataDir,cwd:root}).start(),{code:'APP_SERVER_USER_CONFIG_PRESENT'});
  await assert.rejects(new CodexAppServer({...config.worker,codexHome:home,apiKeyEnv:'UNUSED'},{dataDir:config.dataDir,cwd:root}).start(),{code:'APP_SERVER_API_HOME_MUST_BE_ISOLATED'});
});

test('legacy CLI validation fails before generated code can run on the host',async t=>{
  const {config,task,worker}=await fixture(t,{write:true});config.worker.kind='codex_cli';config.worker.verify=[{executable:'ignored',args:[]}];await assert.rejects(worker.run(task,[]),{code:'VERIFY_REQUIRES_APP_SERVER'});
});

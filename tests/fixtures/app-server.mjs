// Synthetic JSON-RPC peer. Never contacts OpenAI or executes a supplied command.
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const home=process.env.CODEX_HOME,file=path.join(home,'fixture-state.json');
let state;try{state=JSON.parse(await readFile(file,'utf8'));}catch{state={threads:[],calls:[],auth:null};}
state.auth=null;let counter=1;
const option=name=>process.argv.includes(name);
const emit=message=>process.stdout.write(JSON.stringify(message)+'\n');
const save=()=>writeFile(file,JSON.stringify(state));
const complete=async(threadId,turn,text,status='completed')=>{
  turn.status=status;await save();
  emit({method:'item/completed',params:{threadId,turnId:turn.id,item:{id:'item-'+turn.id,type:'agentMessage',text}}});
  emit({method:'turn/completed',params:{threadId,turn}});
};
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  const message=JSON.parse(line),p=message.params??{};
  if(!message.method)continue;
  const safeParams=message.method==='account/login/start'?{type:p.type,hasKey:Boolean(p.apiKey)}:p;
  state.calls.push({method:message.method,params:safeParams,args:process.argv.slice(2),hasInheritedKey:Boolean(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)});await save();
  if(!Object.hasOwn(message,'id'))continue;
  const reply=result=>emit({id:message.id,result});
  if(message.method==='initialize')reply({userAgent:'synthetic'});
  else if(message.method==='account/login/start'){state.auth=p.type;await save();reply({type:p.type});}
  else if(message.method==='account/read')reply({account:{type:option('--fixture-wrong-auth')?'chatgpt':state.auth??'chatgpt'},requiresOpenaiAuth:true});
  else if(message.method==='thread/start'){
    const thread={id:'thread-'+(state.threads.length+1),turns:[]};state.threads.push(thread);await save();reply({thread});
  }else if(message.method==='thread/resume'){
    const thread=state.threads.find(t=>t.id===p.threadId);reply({thread});
  }else if(message.method==='thread/turns/list')reply({data:state.threads.find(t=>t.id===p.threadId).turns,nextCursor:null});
  else if(message.method==='turn/start'){
    const thread=state.threads.find(t=>t.id===p.threadId),turn={id:'turn-'+(thread.turns.length+1),status:'inProgress',items:[],error:null};thread.turns.push(turn);await save();
    if(option('--fixture-disconnect'))process.exit(0);
    reply({turn});
    if(option('--fixture-lost-end')){setTimeout(()=>process.exit(0),20);continue;}
    if(option('--fixture-wait'))continue;
    if(option('--fixture-approval')){emit({id:counter++,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id}});continue;}
    if(p.sandboxPolicy.type==='workspaceWrite')await writeFile(path.join(p.cwd,'created.mjs'),`export const answer = ${thread.turns.length};\n`);
    const result=JSON.stringify({summary:'synthetic verified candidate',files:[]});
    // Another native subagent's final output must not overwrite the root result.
    emit({method:'item/completed',params:{threadId:'child-thread',turnId:turn.id,item:{type:'agentMessage',text:'wrong child output'}}});
    await complete(thread.id,turn,result,option('--fixture-fail')?'failed':'completed');
  }else if(message.method==='turn/interrupt'){
    const thread=state.threads.find(t=>t.id===p.threadId),turn=thread.turns.find(t=>t.id===p.turnId);reply({});await complete(thread.id,turn,'', 'interrupted');
  }else if(message.method==='command/exec'){if(!option('--fixture-verify-wait'))reply({exitCode:option('--fixture-verify-fail')?3:0,stdout:'synthetic validation',stderr:''});}
  else if(message.method==='command/exec/terminate')reply({});
  else emit({id:message.id,error:{code:-32601,message:'Unknown fixture method'}});
}

import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {check,Refused} from './common.mjs';

export function workerEnv(extra={}) {
  const names=['PATH','Path','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','LANG','CODEX_HOME'];
  return {...Object.fromEntries(names.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),PYTHONUTF8:'1',NO_COLOR:'1',...extra};
}
export async function runCommand(executable,args,{cwd,input='',signal,timeoutMs=300000,maxBytes=4000000,onStart=()=>{},env=workerEnv()}={}) {
  check(typeof executable==='string'&&Array.isArray(args),'COMMAND_INVALID');
  check(!signal?.aborted,'CANCELLED');
  // Use a native executable on Windows. No shell interpolation or unquoted .cmd expansion.
  check(!(process.platform==='win32'&&/\.(cmd|bat)$/i.test(executable)),'NATIVE_EXECUTABLE_REQUIRED');
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    let output='',stderr='',bytes=0,stopping=false,reason=null,hardTimer;
    const decoder=new StringDecoder('utf8');
    function kill(signalName){try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signalName);else child.kill(signalName);}catch(e){if(e.code!=='ESRCH')reason='STOP_UNCONFIRMED';}}
    const stop=(code)=>{if(stopping)return;stopping=true;reason=code;kill('SIGTERM');hardTimer=setTimeout(()=>kill('SIGKILL'),2000);hardTimer.unref();};
    const abort=()=>stop('CANCELLED');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop('COMMAND_TIMEOUT'),timeoutMs);timer.unref();
    const cleanup=()=>{clearTimeout(timer);clearTimeout(hardTimer);signal?.removeEventListener('abort',abort);};
    child.once('spawn',()=>{try{onStart({pid:child.pid,createdAt:new Date().toISOString(),groupOwned:process.platform!=='win32'});}catch{stop('START_OBSERVER_FAILED');}});
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes)stop('COMMAND_OUTPUT_LIMIT');else output+=decoder.write(chunk);});
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes)stop('COMMAND_OUTPUT_LIMIT');else stderr+=chunk.toString('utf8');});
    child.once('error',()=>{cleanup();reject(new Refused('COMMAND_UNAVAILABLE'));});
    child.once('close',async(code,endedSignal)=>{
      // Parent exit is not proof that its owned process group has stopped.
      if(process.platform!=='win32'&&child.pid){
        const groupAlive=()=>{try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
        if(groupAlive()){
          if(!stopping)stop('CHILD_PROCESS_REMAINS');
          const until=Date.now()+3000;while(groupAlive()&&Date.now()<until)await new Promise(r=>setTimeout(r,50));
          if(groupAlive())reason='STOP_UNCONFIRMED';
        }
      }
      cleanup();output+=decoder.end();if(reason)reject(Object.assign(new Refused(process.platform==='win32'&&stopping?'STOP_UNCONFIRMED':reason),{exitCode:code,stderr}));else resolve({code,signal:endedSignal,stdout:output,stderr});
    });
    child.stdin.on('error',()=>{});child.stdin.end(input,'utf8');
  });
}

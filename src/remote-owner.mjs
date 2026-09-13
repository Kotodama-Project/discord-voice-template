import {check} from './common.mjs';

async function readLimitedText(response,maxBytes){
  check(response.body?.getReader,'OWNER_RESPONSE_INVALID');const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){const {value,done}=await reader.read();if(done)break;const bytes=Buffer.from(value);size+=bytes.length;check(size<=maxBytes,'OWNER_RESPONSE_LIMIT');chunks.push(bytes);}
    return Buffer.concat(chunks,size).toString('utf8');
  }catch(error){try{await reader.cancel();}catch{}throw error;}finally{reader.releaseLock?.();}
}

/** Private service contract. A remote owner replaces, never mirrors, local Tasks. */
export class RemoteOwner {
  constructor(config){this.kind='remote';this.url=new URL(config.url);check(this.url.protocol==='https:'||(this.url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(this.url.hostname)),'OWNER_TRANSPORT_REFUSED');this.token=process.env[config.tokenEnv];check(this.token,'OWNER_CREDENTIAL_REQUIRED');}
  async call(method,args){const response=await fetch(new URL('/v1/owner',this.url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify({version:1,method,args})});check(response.ok,'REMOTE_OWNER_REFUSED');const value=JSON.parse(await readLimitedText(response,4000000));check(value.version===1&&value.ok===true,'OWNER_PROTOCOL_MISMATCH');return value.result;}
}
for(const method of ['ingest','source','createTask','reviseTask','task','taskInternal','tasks','claim','finish','cancel','resume','confirmStop','bindContext','assertContext'])RemoteOwner.prototype[method]=function(...args){return this.call(method,args);};

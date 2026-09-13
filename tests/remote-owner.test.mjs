import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteOwner} from '../src/remote-owner.mjs';

test('remote owner stops reading and cancels an oversized streamed response',async t=>{
  const previous=globalThis.fetch;let reads=0,cancelled=false;process.env.KOTODAMA_REMOTE_TEST_TOKEN='fixture';
  t.after(()=>{globalThis.fetch=previous;delete process.env.KOTODAMA_REMOTE_TEST_TOKEN;});
  globalThis.fetch=async()=>({ok:true,body:{getReader:()=>({
    read:async()=>{reads++;if(reads===1)return {done:false,value:Buffer.alloc(4_000_001)};throw new Error('READ_PAST_LIMIT');},
    cancel:async()=>{cancelled=true;},releaseLock:()=>{}
  })}});
  const owner=new RemoteOwner({url:'http://127.0.0.1:1',tokenEnv:'KOTODAMA_REMOTE_TEST_TOKEN'});
  await assert.rejects(owner.call('tasks',['actor']),{code:'OWNER_RESPONSE_LIMIT'});
  assert.equal(reads,1);assert.equal(cancelled,true);
});

test('remote owner still parses a bounded streamed JSON response',async t=>{
  const previous=globalThis.fetch;process.env.KOTODAMA_REMOTE_TEST_TOKEN='fixture';t.after(()=>{globalThis.fetch=previous;delete process.env.KOTODAMA_REMOTE_TEST_TOKEN;});
  globalThis.fetch=async()=>new Response(JSON.stringify({version:1,ok:true,result:[{id:'task-1'}]}),{status:200});
  const owner=new RemoteOwner({url:'http://127.0.0.1:1',tokenEnv:'KOTODAMA_REMOTE_TEST_TOKEN'});assert.deepEqual(await owner.tasks('actor'),[{id:'task-1'}]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveResponseCalls} from '../src/live-response-calls.mjs';
test('ported streamed calls survive empty completion and deduplicate',()=>{
  const stream=new LiveResponseCalls();stream.ingest({type:'response.created',response:{id:'r'}});
  const item={type:'function_call',call_id:'c',name:'park_voice_conversation',arguments:'{}'};
  assert.deepEqual(stream.ingest({type:'response.output_item.added',response_id:'r',item}),[]);
  stream.ingest({type:'response.output_item.done',item});stream.ingest({type:'response.output_item.done',response_id:'r',item});
  assert.deepEqual(stream.ingest({type:'response.completed',response:{id:'r',output:[]}}),[item]);
  assert.deepEqual(stream.ingest({type:'response.completed',response:{id:'r',output:[item]}}),[]);
});

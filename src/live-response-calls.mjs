import {check} from './common.mjs';

// Port of the private Live runtime's policy.StreamedToolCalls contract. Completed items can be
// absent from response.completed.output, and duplicate events must not rerun tools.
export class LiveResponseCalls {
  constructor(){this.pending=new Map();this.finished=new Set();this.current=null;}
  ingest(event){
    if(event.type==='response.created')this.current=event.response.id;
    if(event.type==='response.output_item.done'&&event.item?.type==='function_call'){
      const id=event.response_id??this.current,item=event.item;
      check(id&&item.call_id&&typeof item.arguments==='string','LIVE_TOOL_IDENTITY_REQUIRED');
      if(!this.finished.has(id)){if(!this.pending.has(id))this.pending.set(id,new Map());this.pending.get(id).set(item.call_id,item);}
    }
    if(event.type!=='response.completed')return [];
    const response=event.response,id=response.id;if(this.finished.has(id))return [];
    check(this.finished.size<5000,'LIVE_TOOL_LIMIT');this.finished.add(id);if(this.current===id)this.current=null;
    const calls=this.pending.get(id)??new Map();this.pending.delete(id);
    for(const item of response.output??[])if(item.type==='function_call'&&!calls.has(item.call_id))calls.set(item.call_id,item);
    return [...calls.values()];
  }
}

/** Present the saved source verbatim; display never confirms an execution request. */
export function transcriptMessages(source,{state}={}){
  const status=source.final?'ASR 確定':'暫定・実行しません';
  const speaker=source.actorId?`<@${source.actorId}>`:'話者未確定';
  const time=source.metadata?.createdAt??'時刻未記録';
  const prefix=`文字起こし${state==='corrected'?'の訂正':''}（${status}）\n話者 ${speaker} · ${time}\n発話 ${source.sourceId} · 版 ${source.revision}`;
  const chunks=[];let remaining=source.text;
  while(remaining.length){let end=Math.min(1400,remaining.length);if(end<remaining.length&&/[\uD800-\uDBFF]/.test(remaining[end-1]))end--;chunks.push(remaining.slice(0,end));remaining=remaining.slice(end);}
  return chunks.map((text,index)=>({content:`${prefix}${chunks.length>1?` · ${index+1}/${chunks.length}`:''}\n${text}`,allowedMentions:{parse:[]}}));
}

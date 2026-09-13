import {check,digest,atomicJson} from './common.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

export async function exportDocument(store,actor,destination,{room=null,coverage=null}={}){
  const sources=store.sources(actor,room);const intents=store.listIntents(actor);const lines=['# 会話と仕事の資料','',`作成日時: ${new Date().toISOString()}`,'',`読取可能な出典: ${sources.length}件。取得範囲は以下の記録に限定します。`,''];
  if(coverage)lines.push('## 取得範囲','',JSON.stringify(coverage,null,2),'');
  lines.push('## 意図・決定・ToDo','');
  const keys=new Set(sources.map(s=>s.key));
  for(const i of intents.filter(i=>keys.has(i.source_key)))lines.push(`- **${i.kind}** ${i.title} — ${i.request}（出典 ${i.source_key.slice(0,12)} / 版 ${i.source_revision}）`);
  lines.push('','## 出典本文','');
  for(const s of sources){lines.push(`### ${s.provider} · ${s.sourceId}`,'',`出典ID: ${s.key} / 版: ${s.revision}`,'',s.metadata?.url??'',s.text,'');if(s.metadata?.attachments)lines.push('添付の取得状況: '+JSON.stringify(s.metadata.attachments),'');}
  const text=lines.join('\n');await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,text,{encoding:'utf8',mode:0o600,flag:'wx'});
  const receipt={actor,artifact:path.resolve(destination),sha256:digest(text),sourceBindings:sources.map(s=>({key:s.key,revision:s.revision})),classification:'restricted',readers:[actor]};await atomicJson(destination+'.receipt.json',receipt);return receipt;
}
export async function readExport(store,actor,filename){const receipt=JSON.parse(await readFile(filename+'.receipt.json','utf8'));check(receipt.readers.includes(actor),'DOCUMENT_ACCESS_DENIED');for(const b of receipt.sourceBindings){const s=store.source(b.key,actor);check(s.revision===b.revision,'DOCUMENT_STALE');}const bytes=await readFile(filename);check(digest(bytes)===receipt.sha256,'ARTIFACT_CHANGED');return bytes;}

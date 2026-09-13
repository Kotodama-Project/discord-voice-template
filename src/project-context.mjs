import {readdir} from 'node:fs/promises';
import {safePath,digest} from './common.mjs';
import {readArtifact} from './worker.mjs';

// Read the project's curated entrances, not its entire checkout or private home.
export async function readProjectContext(workspace,query,{maxChars=6000}={}){
  const names=['CONTEXT.md','README.md'];
  for(const folder of ['briefs','docs'])try{
    const dir=await safePath(workspace,folder);
    for(const entry of (await readdir(dir,{withFileTypes:true})).filter(e=>e.isFile()&&e.name.endsWith('.md')).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,12))names.push(folder+'/'+entry.name);
  }catch{}
  const text=String(query).slice(0,200).toLowerCase(),terms=new Set(text.match(/[a-z0-9]{2,}/g)??[]);
  for(let i=0;i<text.length-1;i++)if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text[i]))terms.add(text.slice(i,i+2));
  const candidates=[];
  for(const name of names)try{
    const file=await safePath(workspace,name),bytes=await readArtifact(file,65536),body=bytes.toString('utf8'),lines=body.split('\n');
    let best=0,bestScore=0;for(let i=0;i<lines.length;i++){let score=0;const lower=lines[i].toLowerCase();for(const term of terms)if(lower.includes(term))score++;if(score>bestScore){best=i;bestScore=score;}}
    const start=Math.max(0,best-2);candidates.push({path:name,sha256:digest(bytes),line:start+1,text:lines.slice(start,start+35).join('\n').slice(0,2400),score:bestScore});
  }catch{}
  candidates.sort((a,b)=>b.score-a.score);let remaining=maxChars;const sources=[];
  for(const {score,...item} of candidates.slice(0,3)){item.text=item.text.slice(0,remaining);remaining-=item.text.length;if(item.text)sources.push(item);}
  return {status:sources.length?'document_snapshot':'no_curated_documents',observedAt:new Date().toISOString(),sources,currentRuntimeVerified:false};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readProjectContext} from '../src/project-context.mjs';
test('project context is bounded, source-bound, and excludes uncurated files',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'ktdm-context-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'briefs'));
  await writeFile(path.join(root,'README.md'),'概要\n');await writeFile(path.join(root,'briefs','event.md'),'イベントの日時は10月3日です。\n');await writeFile(path.join(root,'secret.txt'),'must not appear');
  const result=await readProjectContext(root,'イベント',{maxChars:100});assert.equal(result.sources[0].path,'briefs/event.md');assert(result.sources.every(s=>s.sha256&&s.line>=1));assert(result.sources.reduce((n,s)=>n+s.text.length,0)<=100);assert(!JSON.stringify(result).includes('must not appear'));assert.equal(result.currentRuntimeVerified,false);
});

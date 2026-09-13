import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,link,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readArtifact} from '../src/worker.mjs';
test('artifact reads enforce limits and file identity on the opened handle',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ktdm-artifact-read-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'result.txt');await writeFile(file,'result');assert.equal((await readArtifact(file,6)).toString(),'result');
  await assert.rejects(readArtifact(file,5),{code:'ARTIFACT_SIZE_LIMIT'});
  await link(file,path.join(dir,'alias'));await assert.rejects(readArtifact(file,6),{code:'ARTIFACT_SIZE_LIMIT'});
});

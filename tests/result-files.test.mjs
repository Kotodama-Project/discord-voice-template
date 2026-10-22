import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resultFiles} from '../src/result-files.mjs';
import {digest} from '../src/common.mjs';
test('only selected deliverables are attached and changed bytes are rejected',async t=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'result-files-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(path.join(workspace,'deliverables'));const file=path.join(workspace,'deliverables/invitation.md');await writeFile(file,'hello');
  const result={workspace,artifacts:[{relative:'review-notes.md',path:'/unrelated/private'},{relative:'deliverables/invitation.md',path:file,sha256:digest('hello'),bytes:5}]};
  const files=await resultFiles(result,{artifactRoot:workspace});assert.equal(files.length,1);assert.equal(files[0].name,'invitation.md');assert.equal(files[0].attachment.toString(),'hello');
  await writeFile(file,'changed');await assert.rejects(resultFiles(result,{artifactRoot:workspace}),/RESULT_FILE_CHANGED/);
});

test('remote results cannot select arbitrary local files without an approved artifact root',async t=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'remote-result-files-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(path.join(workspace,'deliverables'));const file=path.join(workspace,'deliverables/report.md');await writeFile(file,'private-host-data');
  const result={workspace,artifacts:[{relative:'deliverables/report.md',path:file,sha256:digest('private-host-data'),bytes:17}]};
  assert.deepEqual(await resultFiles(result,{artifactRoot:null}),[]);
});

test('results without deliverables do not require an artifact directory',async()=>{
  assert.deepEqual(await resultFiles({workspace:'not-used',artifacts:[]},{artifactRoot:'not-created'}),[]);
});

test('snapshot attachments require the approved task, revision, root, and unchanged regular file',async t=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'snapshot-result-files-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const options={artifactRoot:path.join(root,'worktrees'),snapshotRoot:path.join(root,'artifacts'),taskId:'task-one'},workspace=path.join(options.artifactRoot,options.taskId),snapshot=path.join(options.snapshotRoot,'task-one-r1/files');
  await mkdir(workspace,{recursive:true});await mkdir(path.join(snapshot,'deliverables'),{recursive:true});const file=path.join(snapshot,'deliverables/report.md');await writeFile(file,'report');
  const result={workspace,taskRevision:1,artifactSnapshot:{taskId:'task-one',taskRevision:1,root:snapshot},artifacts:[{relative:'deliverables/report.md',path:file,bytes:6,sha256:digest('report')}]};
  assert.equal((await resultFiles(result,options))[0].attachment.toString(),'report');
  await assert.rejects(resultFiles(result,{...options,taskId:'task-other'}),{code:'RESULT_SNAPSHOT_BINDING_MISMATCH'});
  await assert.rejects(resultFiles({...result,taskRevision:2},options),{code:'RESULT_SNAPSHOT_BINDING_MISMATCH'});
  await assert.rejects(resultFiles(result,{artifactRoot:options.artifactRoot,taskId:options.taskId}),{code:'RESULT_SNAPSHOT_BINDING_MISMATCH'});
  await assert.rejects(resultFiles({...result,artifactSnapshot:{...result.artifactSnapshot,root:workspace}},options),{code:'RESULT_SNAPSHOT_ROOT_MISMATCH'});
  assert.deepEqual(await resultFiles(result,{...options,artifactRoot:null,snapshotRoot:null}),[]);
  await writeFile(file,'alter!');await assert.rejects(resultFiles(result,options),{code:'RESULT_FILE_CHANGED'});
  const elsewhere=path.join(root,'private.md');await writeFile(elsewhere,'report');await rm(file);await symlink(elsewhere,file);await assert.rejects(resultFiles(result,options),{code:'LINK_PATH_REFUSED'});
});

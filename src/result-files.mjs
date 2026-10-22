import {realpath} from 'node:fs/promises';
import {readArtifact} from './worker.mjs';
import path from 'node:path';
import {check,digest,inside,safePath} from './common.mjs';

// Only designated deliverables go to the requesting operator, never every changed file.
export async function resultFiles(result,{artifactRoot,snapshotRoot,taskId}={}){
  const selected=(result?.artifacts??[]).filter(a=>!a.deleted&&/^deliverables\/[A-Za-z0-9_-]+\.(md|html|txt|pdf)$/.test(a.relative));
  if(!selected.length)return [];
  if(!artifactRoot)return [];
  const approvedRoot=await realpath(artifactRoot),workspace=await realpath(result.workspace);check(inside(approvedRoot,workspace),'RESULT_WORKSPACE_REFUSED');
  let filesRoot=workspace;
  if(result.artifactSnapshot){
    const snapshot=result.artifactSnapshot;
    check(snapshotRoot&&typeof taskId==='string'&&/^[A-Za-z0-9_-]+$/.test(taskId)&&snapshot.taskId===taskId&&Number.isSafeInteger(snapshot.taskRevision)&&snapshot.taskRevision>0&&snapshot.taskRevision===result.taskRevision,'RESULT_SNAPSHOT_BINDING_MISMATCH');
    check(workspace===await safePath(approvedRoot,taskId),'RESULT_WORKSPACE_REFUSED');
    filesRoot=await safePath(snapshotRoot,`${taskId}-r${snapshot.taskRevision}/files`);
    check(path.resolve(snapshot.root)===filesRoot,'RESULT_SNAPSHOT_ROOT_MISMATCH');
  }
  const files=[];let size=0;
  for(const a of selected){
    check(files.length<8,'RESULT_FILE_COUNT_LIMIT');
    const file=await safePath(filesRoot,a.relative);
    check(path.relative(await realpath(a.path),file)==='','RESULT_FILE_PATH_MISMATCH');
    check(Number.isSafeInteger(a.bytes)&&a.bytes>=0&&a.bytes<=2000000,'RESULT_FILE_SIZE_LIMIT');
    const bytes=await readArtifact(file,2000000);size+=bytes.length;
    check(size<=8000000&&bytes.length===a.bytes&&digest(bytes)===a.sha256,'RESULT_FILE_CHANGED');
    files.push({attachment:bytes,name:path.basename(a.relative)});
  }
  return files;
}

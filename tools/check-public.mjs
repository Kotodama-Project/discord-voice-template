import {readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));const skip=new Set(['.git','node_modules','.kotodama','artifacts','browser-profile','coverage']);let checked=0;const errors=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(skip.has(entry.name))continue;const file=path.join(dir,entry.name);const relative=path.relative(root,file);if(entry.isSymbolicLink()){errors.push(relative+': symlink');continue;}if(entry.isDirectory()){await walk(file);continue;}if(entry.name.startsWith('.env')&&entry.name!=='.env.example'){errors.push(relative+': env file');continue;}const bytes=await readFile(file);if(bytes.length>2000000){errors.push(relative+': oversized');continue;}const text=bytes.toString('utf8');checked++;
  if(/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/.test(text))errors.push(relative+': secret-shaped token');
  if(/Bearer\s+[a-f0-9]{32,}/i.test(text))errors.push(relative+': bearer value');
  if(/(?:C:[\\/]Users[\\/]|\/home\/openclaw\/|tail[a-z0-9]+\.ts\.net)/i.test(text))errors.push(relative+': private installation path');
}}
await walk(root);const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));if(pkg.license!=='MIT')errors.push('package license mismatch');if(!(await readFile(path.join(root,'LICENSE'),'utf8')).startsWith('MIT License'))errors.push('LICENSE mismatch');
console.log(JSON.stringify({status:errors.length?'FAIL':'PASS',checked,errors}));if(errors.length)process.exitCode=1;

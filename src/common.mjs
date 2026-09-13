import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink, lstat, realpath} from 'node:fs/promises';
import path from 'node:path';

export class Refused extends Error {
  constructor(code, message = code) { super(message); this.name = 'Refused'; this.code = code; }
}
export function check(value, code) { if (!value) throw new Refused(code); }
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const uid = prefix => `${prefix}-${randomUUID()}`;
export const roomKey = (guild, channel) => `discord:${guild}:${channel}`;
const sensitive = new Set(['token','accesstoken','refreshtoken','authtoken','apikey','password','secret','authorization','cookie','setcookie']);
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sensitive.has(k.toLowerCase().replace(/[^a-z0-9]/g,'')) ? '[REDACTED]' : redact(v)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g,'[REDACTED]').replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/\b[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,'[REDACTED]');
}
export function errorCode(error) { return error instanceof Refused ? error.code : 'OPERATION_FAILED'; }
export function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function safePath(root, relative, {mustExist = true} = {}) {
  check(typeof relative === 'string' && !relative.includes('\0') && !path.isAbsolute(relative), 'INVALID_PATH');
  const base = await realpath(root); const target = path.resolve(base, relative);
  check(inside(base,target), 'PATH_OUTSIDE_WORKSPACE');
  let current = base;
  for (const part of path.relative(base,target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { check(!(await lstat(current)).isSymbolicLink(), 'LINK_PATH_REFUSED'); }
    catch (e) { if (e.code !== 'ENOENT' || mustExist) throw e; }
  }
  return target;
}
export async function atomicText(target, value) {
  check(typeof value === 'string', 'ATOMIC_TEXT_REQUIRED');
  await mkdir(path.dirname(target), {recursive:true,mode:0o700});
  try { check(!(await lstat(target)).isSymbolicLink(), 'LINK_PATH_REFUSED'); } catch (e) { if(e.code !== 'ENOENT') throw e; }
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, {encoding:'utf8',mode:0o600,flag:'wx'});
    await rename(temp,target);
  } catch (error) {
    try { await unlink(temp); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError; }
    throw error;
  }
}
export async function atomicJson(target, value) { await atomicText(target, JSON.stringify(value,null,2)+'\n'); }
export const readJson = async p => JSON.parse(await readFile(p,'utf8'));
export function sourceIdentity(s) { return digest([s.provider,s.guildId,s.channelId,s.sourceId]); }
export function sourceFingerprint(s) { return digest({text:s.text,actorId:s.actorId,readers:[...s.readers].sort(),final:s.final,withdrawn:s.withdrawn ?? false,metadata:s.metadata ?? {}}); }
export function shortText(value, max=1900) { return String(value).slice(0,max).replace(/@everyone|@here/g, x => x.replace('@','＠')); }

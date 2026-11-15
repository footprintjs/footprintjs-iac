import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { FileStateStore } from '../store.ts';
import { fingerprint } from '../util.ts';
import { readReleaseManifest } from '../releases/manifest.ts';
import { digest, object, readPipelineState, readPipelineTarget, readVerifiedRelease, text } from './data.ts';
import type { ReleaseManifest } from '../releases/types.ts';
import type { PipelineState, PipelineTarget, VerifiedRelease } from './types.ts';

const MAX_BYTES = 16 * 1024 * 1024;
async function readJson(path: string): Promise<unknown | undefined> {
  try { const info = await stat(path); if (!info.isFile() || info.size > MAX_BYTES) throw Error('Pipeline ledger exceeds local limits'); return JSON.parse(await readFile(path,'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value,null,2) + '\n'; if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('Pipeline evidence exceeds local limits');
  const directory = dirname(path); await mkdir(directory,{recursive:true,mode:0o700});
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary,'wx',0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary,path);
    const parent = await open(directory,'r'); try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary,{force:true}); }
}
/** A private immutable attempt directory. Never reuse it for another release or policy. */
export class FilePipelineStore {
  readonly directory: string; readonly path: string; private readonly locks: FileStateStore;
  constructor(directory: string) { this.directory=resolve(directory); this.path=join(this.directory,'pipeline.json'); this.locks=new FileStateStore(join(this.directory,'locks')); }
  async load(): Promise<PipelineState | undefined> { const value=await readJson(this.path); return value === undefined ? undefined : readPipelineState(value); }
  async save(state: PipelineState): Promise<void> { await this.writeJson(this.path,readPipelineState(state)); }
  async writeJson(path: string,value: unknown): Promise<void> {
    if (dirname(resolve(path)) !== this.directory) throw Error('Pipeline evidence must remain inside its bound directory');
    await writeJson(path,value);
  }
  withLock<T>(work:()=>Promise<T>):Promise<T> { return this.locks.withLock('pipeline',work); }
}
export interface PipelineTargetState {
  version:1; kind:'pipeline-target'; target:PipelineTarget;
  lastApplied?: ReleaseManifest; lastVerified?: VerifiedRelease; lastExecutionId?: string;
  pending?: {executionId:string;stageId:string;operationId:string;releaseDigest:string};
}
function readTargetState(input: unknown,target:PipelineTarget):PipelineTargetState {
  const value=object(input,['version','kind','target','lastApplied','lastVerified','lastExecutionId','pending']);
  if(value.version!==1||value.kind!=='pipeline-target'||fingerprint(readPipelineTarget(value.target))!==fingerprint(target))throw Error('Pipeline target binding changed');
  if(value.lastApplied!==undefined)readReleaseManifest(value.lastApplied);
  if(value.lastVerified!==undefined){const verified=readVerifiedRelease(value.lastVerified);readReleaseManifest(verified.release);}
  if(value.lastExecutionId!==undefined)text(value.lastExecutionId);
  if(value.pending!==undefined){const pending=object(value.pending,['executionId','stageId','operationId','releaseDigest']);text(pending.executionId);text(pending.stageId);text(pending.operationId);digest(pending.releaseDigest);}
  return structuredClone(value) as unknown as PipelineTargetState;
}
/** All attempts for one real target must share this local directory. This is not a distributed lock. */
export class FilePipelineTargetStore {
  readonly directory:string;private readonly locks:FileStateStore;
  constructor(directory:string){this.directory=resolve(directory);this.locks=new FileStateStore(join(this.directory,'locks'));}
  private key(target:PipelineTarget):string{return fingerprint(readPipelineTarget(target));}
  async load(target:PipelineTarget):Promise<PipelineTargetState>{
    const value=await readJson(join(this.directory,this.key(target)+'.json'));
    return value===undefined?{version:1,kind:'pipeline-target',target:readPipelineTarget(target)}:readTargetState(value,target);
  }
  async save(state:PipelineTargetState):Promise<void>{await writeJson(join(this.directory,this.key(state.target)+'.json'),readTargetState(state,state.target));}
  withLock<T>(target:PipelineTarget,work:()=>Promise<T>):Promise<T>{return this.locks.withLock(this.key(target),work);}
}

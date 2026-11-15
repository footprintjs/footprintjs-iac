import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileStateStore } from '../store.ts';
import { identifier } from '../graph/data.ts';
import { readTriggerJob } from './data.ts';
import type { TriggerJobState, TriggerStore } from './types.ts';

export class TriggerStoreBusyError extends Error { constructor() { super('The trigger job is leased by another local scheduler process'); this.name='TriggerStoreBusyError'; } }

/** Durable local jobs. Multi-host schedulers must supply a transactional shared store instead. */
export class FileTriggerStore implements TriggerStore {
  private static readonly transactions=new Map<string,Promise<void>>();
  readonly directory: string; private readonly locks: FileStateStore;
  constructor(directory: string) { this.directory = resolve(directory); this.locks = new FileStateStore(join(this.directory, 'locks')); }
  private path(id: string): string { return join(this.directory, identifier(id, 'trigger') + '.json'); }
  async load(id: string): Promise<TriggerJobState | undefined> {
    const path = this.path(id);
    try {
      const info = await stat(path); if (!info.isFile() || info.size > 16 * 1024 * 1024) throw Error('Bound trigger ledger');
      return readTriggerJob(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  async save(input: TriggerJobState): Promise<void> {
    const state = readTriggerJob(input), path = this.path(state.definition.id), bytes = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw Error('Archive trigger history before further dispatch');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const parent = await open(this.directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    identifier(id,'trigger');const key=join(this.directory,id),previous=FileTriggerStore.transactions.get(key)??Promise.resolve();
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),pending=previous.then(()=>gate);
    FileTriggerStore.transactions.set(key,pending);await previous;let entered=false;
    try{return await this.locks.withLock(id,()=>{entered=true;return work();});}
    catch(error){if(!entered&&error instanceof Error&&/locked by live PID/.test(error.message))throw new TriggerStoreBusyError();throw error;}
    finally{release();if(FileTriggerStore.transactions.get(key)===pending)FileTriggerStore.transactions.delete(key);}
  }
  runDirectory(triggerId: string, invocationId: string): string {
    return join(this.directory, 'runs', identifier(triggerId, 'trigger'), identifier(invocationId, 'invocation'));
  }
}

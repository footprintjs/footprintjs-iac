import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FlowchartCheckpoint } from 'footprintjs';
import { FileStateStore } from '../store.ts';
import { fingerprint } from '../util.ts';
import { readResourceFlowState } from './data.ts';
import type { ResourceFlowState } from './types.ts';

export interface StoredResourceFlow { version: 1; state: ResourceFlowState; checkpoint?: FlowchartCheckpoint; checkpointDigest?: string }
const maxBytes = 16 * 1024 * 1024;
/** A local, atomic ledger. A human pause retains no open lock or provider connection. */
export class FileResourceFlowStore {
  readonly directory: string;
  readonly path: string;
  private readonly locks: FileStateStore;
  constructor(directory: string) {
    this.directory = resolve(directory); this.path = join(this.directory, 'resource-flow.json');
    this.locks = new FileStateStore(join(this.directory, 'locks'));
  }
  async load(): Promise<StoredResourceFlow | undefined> {
    try {
      const info = await stat(this.path); if (!info.isFile() || info.size > maxBytes) throw Error('Resource flow ledger exceeds local limits');
      const value = JSON.parse(await readFile(this.path, 'utf8')) as StoredResourceFlow;
      if (value.version !== 1 || Object.keys(value).some(key => !['version', 'state', 'checkpoint', 'checkpointDigest'].includes(key))) throw Error('Unsupported resource flow ledger');
      const state = readResourceFlowState(value.state);
      if (value.checkpoint !== undefined && fingerprint(value.checkpoint) !== value.checkpointDigest) throw Error('Resource flow checkpoint digest differs');
      if (state.status === 'paused' && (!value.checkpoint || !value.checkpointDigest)) throw Error('A paused resource flow requires its native checkpoint');
      return { ...value, state };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  async save(input: StoredResourceFlow): Promise<void> {
    readResourceFlowState(input.state);
    if (input.checkpoint && fingerprint(input.checkpoint) !== input.checkpointDigest) throw Error('Resource flow checkpoint digest differs');
    await this.writeJson(this.path, input);
  }
  async writeJson(path: string, value: unknown): Promise<void> {
    const bytes = JSON.stringify(value, null, 2) + '\n'; if (Buffer.byteLength(bytes) > maxBytes) throw Error('Resource flow evidence exceeds local limits');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  withLock<T>(work: () => Promise<T>): Promise<T> { return this.locks.withLock('resource-flow', work); }
}

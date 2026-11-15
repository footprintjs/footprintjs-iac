import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileStateStore } from '../store.ts';
import { readCheckExecution } from './state.ts';
import type { CheckExecutionState } from './types.ts';

export class FileCheckStore {
  readonly directory: string; readonly path: string; private readonly locks: FileStateStore;
  constructor(directory: string) { this.directory = resolve(directory); this.path = join(this.directory, 'check.json'); this.locks = new FileStateStore(join(this.directory, 'locks')); }
  async load(): Promise<CheckExecutionState | undefined> {
    try {
      const info = await stat(this.path); if (!info.isFile() || info.size > 8 * 1024 * 1024) throw Error('Bound check ledger');
      return readCheckExecution(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  save(value: CheckExecutionState): Promise<void> { return this.writeJson(this.path, readCheckExecution(value)); }
  async writeJson(path: string, value: unknown): Promise<void> {
    if (resolve(path, '..') !== this.directory) throw Error('Check evidence must remain in its bound directory');
    const bytes = JSON.stringify(value, null, 2) + '\n'; if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw Error('Bound check evidence');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const parent = await open(this.directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  withLock<T>(work: () => Promise<T>): Promise<T> { return this.locks.withLock('check', work); }
}

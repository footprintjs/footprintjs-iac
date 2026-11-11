import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileStateStore } from '../store.ts';
import { emptyMasterState, readMasterState } from './state.ts';
import type { MasterState } from './types.ts';

const MAX_BYTES = 16 * 1024 * 1024;
/** Local atomic JSON ledger. No revision or attempt is discarded to make room. */
export class FileMasterStore {
  readonly directory: string;
  readonly path: string;
  private readonly locks: FileStateStore;
  constructor(directory: string) {
    this.directory = resolve(directory); this.path = join(this.directory, 'master.json');
    this.locks = new FileStateStore(join(this.directory, 'locks'));
  }
  async load(): Promise<MasterState> {
    try {
      const info = await stat(this.path); if (!info.isFile() || info.size > MAX_BYTES) throw Error('Master JSON exceeds local storage limits');
      return readMasterState(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readMasterState(emptyMasterState());
      throw error;
    }
  }
  /** Trusted storage port. Workflow callers hold withLock across read, intent, effects and outcome. */
  async save(input: MasterState): Promise<void> {
    const state = readMasterState(input), bytes = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('Master history is full; archive explicitly rather than dropping revisions');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.path + '.tmp-' + randomUUID(), file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  withLock<T>(work: () => Promise<T>): Promise<T> { return this.locks.withLock('master-system-ledger', work); }
}

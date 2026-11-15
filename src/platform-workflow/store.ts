import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FlowchartCheckpoint } from 'footprintjs';
import { FileResourceFlowStore } from '../resource-flow/store.ts';
import { fingerprint } from '../util.ts';
import { readPlatformBootstrapState } from './data.ts';
import type { PlatformBootstrapState } from './types.ts';

export interface StoredPlatformBootstrap { version: 1; state: PlatformBootstrapState; checkpoint?: FlowchartCheckpoint; checkpointDigest?: string }
/** Uses the same atomic local persistence and lock implementation as ResourceFlow. */
export class FilePlatformBootstrapStore {
  readonly directory: string;
  readonly path: string;
  private readonly files: FileResourceFlowStore;
  constructor(directory: string) {
    this.directory = resolve(directory); this.path = join(this.directory, 'platform-bootstrap.json');
    this.files = new FileResourceFlowStore(this.directory);
  }
  async load(): Promise<StoredPlatformBootstrap | undefined> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw Error('Platform state exceeds local limits');
      const value = JSON.parse(await readFile(this.path, 'utf8')) as StoredPlatformBootstrap;
      if (value.version !== 1 || Object.keys(value).some(key => !['version', 'state', 'checkpoint', 'checkpointDigest'].includes(key))) throw Error('Unsupported platform store');
      const state = readPlatformBootstrapState(value.state);
      if (value.checkpoint !== undefined && fingerprint(value.checkpoint) !== value.checkpointDigest) throw Error('Platform checkpoint differs');
      if (state.status === 'paused' && (!value.checkpoint || !value.checkpointDigest)) throw Error('Platform pause has no native checkpoint');
      return { ...value, state };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw Error('The retained platform state could not be admitted'); }
  }
  async save(value: StoredPlatformBootstrap): Promise<void> {
    readPlatformBootstrapState(value.state);
    if (value.checkpoint && fingerprint(value.checkpoint) !== value.checkpointDigest) throw Error('Platform checkpoint differs');
    await this.files.writeJson(this.path, value);
  }
  writeJson(path: string, value: unknown): Promise<void> { return this.files.writeJson(path, value); }
  withLock<T>(work: () => Promise<T>): Promise<T> { return this.files.withLock(work); }
}

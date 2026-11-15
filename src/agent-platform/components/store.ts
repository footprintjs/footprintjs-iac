import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileResourceFlowStore } from '../../resource-flow/store.ts';
import { row, digest, label } from '../data.ts';
import type { AgentComponentsState } from './types.ts';

export interface StoredAgentComponents {
 version: 1; definitionDigest: string; executionId: string; status: AgentComponentsState['status']; maxConcurrency: number;
 segments: AgentComponentsState['segments'];
}
/** Atomic private intent ledger; native child workflows own all provider effects. */
export class AgentComponentsStore {
 readonly directory: string; readonly path: string; private readonly files: FileResourceFlowStore;
 constructor(directory: string) { this.directory = resolve(directory); this.path = join(this.directory, 'agent-components.json'); this.files = new FileResourceFlowStore(this.directory); }
 async load(): Promise<StoredAgentComponents | undefined> {
  try {
   const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw Error('Agent components intent file exceeds limits');
   const value = row(JSON.parse(await readFile(this.path, 'utf8')), ['version', 'definitionDigest', 'executionId', 'status', 'maxConcurrency', 'segments']);
   if (value.version !== 1 || !['running', 'ready', 'failed', 'paused', 'incomplete'].includes(String(value.status)) || !Number.isSafeInteger(value.maxConcurrency)
    || !Array.isArray(value.segments) || value.segments.length > 256) throw Error('Unsupported agent components intent');
   for (const segment of value.segments) {
    const fields = row(segment, ['runId', 'evidencePath', 'tracePath', 'status', 'resumedFromRunId']);
    for (const key of ['runId', 'evidencePath', 'tracePath']) label(fields[key], 4096);
    if (!['passed', 'failed', 'paused', 'incomplete'].includes(String(fields.status))) throw Error('Unsupported component coordinator segment');
    if (fields.resumedFromRunId !== undefined) label(fields.resumedFromRunId, 512);
   }
   digest(value.definitionDigest); label(value.executionId, 128);
   return value as unknown as StoredAgentComponents;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
 }
 save(value: StoredAgentComponents): Promise<void> { return this.files.writeJson(this.path, value); }
 writeJson(path: string, value: unknown): Promise<void> { return this.files.writeJson(path, value); }
 withLock<T>(work: () => Promise<T>): Promise<T> { return this.files.withLock(work); }
}

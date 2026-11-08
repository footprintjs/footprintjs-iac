import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { JournalEntry, StackState, StateStore } from './types.ts';
import { readResourceLifecycle } from './resource-lifecycle.ts';

type LockOwner = { pid: number; token: string };

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function safeKey(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('State identifiers must contain 1–512 characters');
  }
  return createHash('sha256').update(value).digest('hex');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validOwner(value: unknown): value is LockOwner {
  return object(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
    typeof value.token === 'string' && value.token.length > 0 && value.token.length <= 512;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Lack of permission cannot establish that a process is dead.
    if (code(error) === 'ESRCH') return false;
    return true;
  }
}

function validateState(value: unknown, stack: string): asserts value is StackState {
  if (!object(value) || value.version !== 1 || value.stack !== stack || !object(value.resources)) {
    throw new Error(`Invalid state for stack ${JSON.stringify(stack)}`);
  }
  if (value.providerScopes !== undefined && (!object(value.providerScopes) ||
      !Object.values(value.providerScopes).every(scope => typeof scope === 'string'))) {
    throw new Error(`Invalid provider scopes for stack ${JSON.stringify(stack)}`);
  }
  for (const [key, managed] of Object.entries(value.resources)) {
    if (!object(managed) || typeof managed.fingerprint !== 'string' ||
        (managed.physicalId !== undefined && typeof managed.physicalId !== 'string') ||
        !object(managed.resource)) {
      throw new Error(`Invalid managed resource ${JSON.stringify(key)}`);
    }
    if (managed.pending !== undefined && (!object(managed.pending) ||
        typeof managed.pending.operationId !== 'string' || managed.pending.operationId.length === 0 ||
        !['create', 'update'].includes(managed.pending.action as string) ||
        typeof managed.pending.desiredFingerprint !== 'string' || managed.pending.desiredFingerprint.length === 0)) {
      throw new Error(`Invalid pending operation for resource ${JSON.stringify(key)}`);
    }
    const resource = managed.resource;
    readResourceLifecycle(resource.lifecycle);
    if (resource.id !== key || typeof resource.provider !== 'string' || resource.provider.length === 0 ||
        !object(resource.spec) || (resource.dependsOn !== undefined &&
          (!Array.isArray(resource.dependsOn) || !resource.dependsOn.every(id => typeof id === 'string')))) {
      throw new Error(`Invalid resource definition ${JSON.stringify(key)}`);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * A local, single-machine store. Every acknowledged mutation is fsynced.
 * This is not a distributed lock service: use a shared transactional backend
 * when multiple hosts may manage the same stack. Callers hold withLock across
 * load/plan/effects/save. Missing/malformed owners and interrupted reclaimers
 * require inspection, rather than guessing that a lock may be stolen.
 */
export class FileStateStore implements StateStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  statePath(stack: string): string {
    return join(this.directory, `stack-${safeKey(stack)}.json`);
  }

  lockPath(stack: string): string {
    return join(this.directory, `stack-${safeKey(stack)}.lock`);
  }

  async load(stack: string): Promise<StackState> {
    let bytes: string;
    try { bytes = await readFile(this.statePath(stack), 'utf8'); } catch (error) {
      if (code(error) === 'ENOENT') return { version: 1, stack, resources: {} };
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(bytes); } catch {
      throw new Error(`State file for ${JSON.stringify(stack)} is not valid JSON`);
    }
    validateState(value, stack);
    return value;
  }

  async save(state: StackState): Promise<void> {
    validateState(state, state.stack);
    await this.atomicJson(this.statePath(state.stack), state);
  }

  async append(entry: JournalEntry): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
    const handle = await open(join(this.directory, 'journal.jsonl'), 'a', 0o600);
    try {
      // One O_APPEND write keeps independent stack entries from sharing offsets.
      const result = await handle.write(bytes);
      if (result.bytesWritten !== bytes.length) throw new Error('Partial journal write; recovery requires journal inspection');
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(this.directory);
  }

  async readJournal(): Promise<JournalEntry[]> {
    let bytes: string;
    try { bytes = await readFile(join(this.directory, 'journal.jsonl'), 'utf8'); } catch (error) {
      if (code(error) === 'ENOENT') return [];
      throw error;
    }
    return bytes.split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as JournalEntry; } catch {
        throw new Error(`Malformed journal entry at line ${index + 1}; refusing to hide it`);
      }
    });
  }

  async saveEvidence(runId: string, evidence: unknown): Promise<string> {
    const path = join(this.directory, `run-${safeKey(runId)}.json`);
    await this.atomicJson(path, evidence);
    return path;
  }

  async withLock<T>(stack: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.lockPath(stack);
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    for (;;) {
      try {
        await mkdir(path, { mode: 0o700 });
        break;
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        await this.reclaimDeadLock(path, stack);
      }
    }
    try {
      await this.atomicJson(join(path, 'owner.json'), owner);
      await syncDirectory(this.directory);
      return await work();
    } finally {
      // The owner's directory cannot be reclaimed while this PID is alive.
      // If owner creation itself failed, this process still owns the mkdir.
      await rm(path, { recursive: true, force: true });
      await syncDirectory(this.directory);
    }
  }

  private async reclaimDeadLock(path: string, stack: string): Promise<void> {
    let owner: unknown;
    try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')); } catch (error) {
      // A lock may have been removed between the failed mkdir and this read.
      if (code(error) === 'ENOENT') {
        // An incomplete lock directory is not evidence of a dead owner.
        try { await readFile(join(path, 'owner.json'), 'utf8'); } catch (second) {
          if (code(second) === 'ENOENT') {
            const { stat } = await import('node:fs/promises');
            try { await stat(path); } catch (absent) {
              if (code(absent) === 'ENOENT') return;
              throw absent;
            }
          }
        }
      }
      throw new Error(`Stack ${JSON.stringify(stack)} has an incomplete or unreadable lock; inspect ${path}`);
    }
    if (!validOwner(owner)) throw new Error(`Stack ${JSON.stringify(stack)} has a malformed lock; inspect ${path}`);
    if (alive(owner.pid)) throw new Error(`Stack ${JSON.stringify(stack)} is locked by live PID ${owner.pid}`);

    // Serialize stale reclamation inside the existing directory. A contender
    // that read an old owner before a replacement lock appeared must recheck
    // ownership after obtaining this marker, before renaming anything.
    const markerPath = join(path, `reclaim-${safeKey(owner.token)}`);
    let marker;
    try { marker = await open(markerPath, 'wx', 0o600); } catch (error) {
      if (code(error) === 'ENOENT') return;
      if (code(error) === 'EEXIST') throw new Error(`Stale lock reclamation is already in progress; inspect ${path}`);
      throw error;
    }
    let moved = false;
    try {
      await marker.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
      await marker.sync();
      const current: unknown = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
      if (!validOwner(current) || current.pid !== owner.pid || current.token !== owner.token || alive(current.pid)) return;
      const tombstone = `${path}.stale-${randomUUID()}`;
      await rename(path, tombstone);
      moved = true;
      await syncDirectory(this.directory);
      await rm(tombstone, { recursive: true, force: true });
    } finally {
      await marker.close();
      if (!moved) await rm(markerPath, { force: true });
    }
  }

  private async atomicJson(path: string, value: unknown): Promise<void> {
    const bytes = JSON.stringify(value, null, 2);
    if (bytes === undefined) throw new Error('Cannot persist an undefined JSON document');
    const parent = resolve(path, '..');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomUUID()}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${bytes}\n`);
      await handle.sync();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally { await handle.close(); }
    try {
      await rename(temporary, path);
      await syncDirectory(parent);
    } finally { await rm(temporary, { force: true }); }
  }
}

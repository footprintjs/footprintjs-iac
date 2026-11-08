import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JsonObject, Observation, ProviderContext, Resource, ResourceAdapter } from '../types.ts';
import { fingerprint } from '../util.ts';

interface Entry { spec: JsonObject; owner: string; physicalId: string }
export interface SimulatorFaults {
  failBeforeApply?: Set<string>;
  loseResponseAfterApply?: Set<string>;
  afterEffect?: (resource: Resource) => Promise<void>;
}

/** A deterministic provider with instance-local transactions and optional disk persistence. */
export class SimulatorAdapter implements ResourceAdapter {
  readonly name = 'simulator';
  readonly supportsSafeRetry = true;
  readonly scope: string;
  readonly calls: { action: string; id: string; operationId: string }[] = [];
  private entries: Record<string, Entry> = {};
  private readonly file: string | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  readonly faults: SimulatorFaults;
  constructor(options: { file?: string; faults?: SimulatorFaults } = {}) {
    this.file = options.file;
    this.scope = options.file ?? 'in-memory';
    this.faults = options.faults ?? {};
  }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async refresh(): Promise<void> {
    if (!this.file) return;
    try { this.entries = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, Entry>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.entries = {};
    }
  }
  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.entries), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }
  private owner(resource: Resource, context: ProviderContext): string { return `${context.stack}/${resource.id}`; }
  private observation(resource: Resource, context: ProviderContext): Observation {
    const entry = this.entries[resource.id];
    return entry ? { exists: true, owned: entry.owner === this.owner(resource, context), fingerprint: fingerprint(entry.spec), physicalId: entry.physicalId, ready: true }
      : { exists: false, physicalId: `sim://${resource.id}` };
  }
  async observe(resource: Resource, context: ProviderContext): Promise<Observation> {
    return this.transaction(async () => { await this.refresh(); return this.observation(resource, context); });
  }
  async apply(resource: Resource, context: ProviderContext): Promise<void> {
    await this.transaction(async () => {
      await this.refresh();
      const observed = this.observation(resource, context);
      if (observed.exists && !observed.owned) throw new Error(`Unowned simulator resource ${resource.id}`);
      this.calls.push({ action: 'apply', id: resource.id, operationId: context.operationId });
      if (this.faults.failBeforeApply?.has(resource.id)) throw new Error(`Injected failure for ${resource.id}`);
      this.entries[resource.id] = { spec: structuredClone(resource.spec), owner: this.owner(resource, context), physicalId: `sim://${resource.id}` };
      await this.persist();
    });
    // The provider effect is committed. Response delay/loss must not hold the storage transaction.
    await this.faults.afterEffect?.(resource);
    if (this.faults.loseResponseAfterApply?.delete(resource.id)) throw new Error('Response lost after provider applied the resource');
  }
  async remove(resource: Resource, context: ProviderContext): Promise<void> {
    await this.transaction(async () => {
      await this.refresh();
      const observed = this.observation(resource, context);
      if (observed.exists && !observed.owned) throw new Error(`Unowned simulator resource ${resource.id}`);
      this.calls.push({ action: 'delete', id: resource.id, operationId: context.operationId });
      delete this.entries[resource.id];
      await this.persist();
    });
  }
  async waitReady(): Promise<void> {}
  async injectDrift(id: string, spec: JsonObject): Promise<void> {
    await this.transaction(async () => {
      await this.refresh();
      if (!this.entries[id]) throw new Error('Missing simulator resource');
      this.entries[id].spec = structuredClone(spec);
      await this.persist();
    });
  }
}

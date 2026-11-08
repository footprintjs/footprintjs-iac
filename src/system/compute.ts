import type { JsonObject } from '../types.ts';
import { jsonCopy } from '../graph/data.ts';
import { CapabilityBuilder } from './leaf.ts';
import { DeclarationScope, invokeScope } from './scope.ts';
import { readArtifact, readReference } from './references.ts';
import { durationFields, positiveInteger } from './property-values.ts';
import type { ArtifactReference, Capability, NetworkReference, PrincipalReference, StorageAccess, StoreReference } from './types.ts';

export class ComputationBuilder extends CapabilityBuilder {
  constructor(group: string, id: string, kind: 'service' | 'job' | 'scheduled-task' = 'service') { super(group, id, 'compute', kind); }
  program(value: ArtifactReference): this { return this.set('program', readArtifact(value)); }
  replicas(value: number): this { return this.set('replicas', positiveInteger(value, 'replicas')); }
  useNetwork(value: NetworkReference): this {
    const network = readReference(value, 'network');
    const networks = (this.properties.networks as JsonObject[] | undefined) ?? [];
    if (networks.some(row => row.path === network.path)) throw new Error('Duplicate network use');
    return this.set('networks', [...networks, network]);
  }
  useStorage(value: StoreReference, options: { access: StorageAccess }): this {
    const store = readReference(value, 'store');
    const copied = jsonCopy(options) as JsonObject;
    if (!copied || typeof copied !== 'object' || Array.isArray(copied)
      || Object.keys(copied).some(key => key !== 'access')
      || !['read', 'write', 'readWrite'].includes(String(copied.access))) throw new Error('Storage use requires an explicit valid access mode');
    const stores = (this.properties.stores as JsonObject[] | undefined) ?? [];
    if (stores.some(row => (row.ref as JsonObject).path === store.path)) throw new Error('Duplicate store use');
    return this.set('stores', [...stores, { ref: store, access: copied.access }]);
  }
  runAs(value: PrincipalReference): this { return this.set('runAs', readReference(value, 'principal')); }
}
export class ScheduledTaskBuilder extends ComputationBuilder {
  constructor(group: string, id: string) { super(group, id, 'scheduled-task'); }
  schedule(value: { every: string }): this { return this.set('schedule', durationFields(value, ['every'], 'interval schedule')); }
}
export class ComputeScope extends DeclarationScope {
  private readonly capabilities: Capability[] = [];
  private readonly group: string;
  constructor(group: string) { super(); this.group = group; }
  addService(id: string, callback: (service: ComputationBuilder) => ComputationBuilder | void): this { return this.add(id, callback, 'service'); }
  addJob(id: string, callback: (job: ComputationBuilder) => ComputationBuilder | void): this { return this.add(id, callback, 'job'); }
  addScheduledTask(id: string, callback: (task: ScheduledTaskBuilder) => ScheduledTaskBuilder | void): this {
    this.assertOpen();
    const task = new ScheduledTaskBuilder(this.group, id);
    invokeScope(task, callback);
    this.capabilities.push(task.snapshot());
    return this;
  }
  private add(id: string, callback: (work: ComputationBuilder) => ComputationBuilder | void, kind: 'service' | 'job'): this {
    this.assertOpen();
    const work = new ComputationBuilder(this.group, id, kind);
    invokeScope(work, callback);
    this.capabilities.push(work.snapshot());
    return this;
  }
  /** @internal */ snapshot(): Capability[] { return [...this.capabilities]; }
}

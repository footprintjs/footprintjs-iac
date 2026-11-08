import type { JsonObject } from '../types.ts';
import { readReference } from './references.ts';
import type { Capability, CapabilityRelation, Principal, Reference } from './types.ts';

export function resolveCapability(reference: Reference, capabilities: readonly Capability[]): Capability {
  const row = readReference(reference);
  if (row.kind === 'principal') throw new Error('A principal is not a compute/storage/network capability');
  const capability = capabilities.find(candidate => candidate.path === row.path);
  if (!capability) throw new Error(`Unknown capability reference: ${row.path}`);
  const matches = row.kind === 'store' ? capability.kind === 'store'
    : row.kind === 'service' ? capability.kind === 'service'
    : capability.kind === 'segment' || capability.kind === 'endpoint';
  if (!matches) throw new Error(`Reference kind mismatch at ${row.path}`);
  return capability;
}
export function relationKey(row: CapabilityRelation): string { return JSON.stringify([row.from, row.to, row.kind]); }
/** Declared uses create dependency/communication edges; they are not observed runtime provenance. */
export function inferredRelations(capabilities: readonly Capability[], principals: readonly Principal[]): CapabilityRelation[] {
  const relations: CapabilityRelation[] = [];
  for (const capability of capabilities) {
    if (capability.family === 'compute') {
      for (const value of (capability.properties.networks as JsonObject[] | undefined) ?? []) {
        const network = resolveCapability(readReference(value, 'network'), capabilities);
        relations.push({ from: network.id, to: capability.id, kind: 'dependsOn', label: 'uses network' });
      }
      for (const use of (capability.properties.stores as JsonObject[] | undefined) ?? []) {
        const store = resolveCapability(readReference(use.ref, 'store'), capabilities);
        relations.push({ from: store.id, to: capability.id, kind: 'dependsOn', label: 'uses storage' });
        relations.push({ from: capability.id, to: store.id, kind: 'communicatesWith', label: `storage access: ${use.access}` });
      }
      if (capability.properties.runAs !== undefined) {
        const identity = readReference(capability.properties.runAs, 'principal');
        if (!principals.some(candidate => candidate.path === identity.path)) throw new Error(`Unknown principal reference: ${identity.path}`);
      }
    }
    if (capability.kind === 'endpoint' && capability.properties.target !== undefined) {
      const service = resolveCapability(readReference(capability.properties.target, 'service'), capabilities);
      relations.push({ from: service.id, to: capability.id, kind: 'dependsOn', label: 'endpoint target' });
      relations.push({ from: capability.id, to: service.id, kind: 'communicatesWith', label: 'routes to service' });
    }
  }
  return relations;
}

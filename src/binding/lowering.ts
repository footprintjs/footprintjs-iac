import { compileGraph } from '../graph/compile.ts';
import { array, keys, object } from '../graph/data.ts';
import { readResource } from '../graph/resources.ts';
import type { Relation } from '../graph/types.ts';
import type { Capability } from '../system/types.ts';
import type { JsonObject, Resource } from '../types.ts';
import type { CapabilityAdapter, CapabilityMapping, LoweredCapability } from './types.ts';

export function validateLowering(
  input: unknown, capability: Capability, adapter: CapabilityAdapter, allocated: Set<string>,
): { lowering: LoweredCapability; entries: string[]; exits: string[] } {
  const row = object(input as never, 'lowered capability');
  keys(row, ['resources', 'internalRelations'], 'lowered capability');
  const resources = array(row.resources, 'lowered resources').map(readResource);
  if (resources.length === 0 || resources.length > 256) throw new Error('A capability must lower to 1..256 resources');
  for (const resource of resources) {
    if (!allocated.has(resource.id)) throw new Error('Lowered resource must use context.resourceId(): ' + resource.id);
    if ((adapter.mode === 'simulation') !== (resource.provider === 'simulator')) throw new Error('Adapter mode and lowered provider disagree');
  }
  const ids = new Set(resources.map(resource => resource.id));
  for (const resource of resources) for (const dependency of resource.dependsOn ?? []) {
    if (!ids.has(dependency)) throw new Error('Lowered dependencies must stay within their capability');
  }
  const internalRelations = row.internalRelations === undefined ? [] : array(row.internalRelations, 'internal relations').map(value => {
    const edge = object(value, 'internal relation');
    if (!ids.has(String(edge.from)) || !ids.has(String(edge.to))) throw new Error('Internal relation crosses a capability boundary');
    return edge as unknown as Relation;
  });
  const fragment = compileGraph({ name: capability.id, resources, boundaries: [], memberships: [], relations: internalRelations });
  const entries = fragment.resources.filter(resource => !resource.dependsOn?.length).map(resource => resource.id);
  const sources = new Set(fragment.resources.flatMap(resource => resource.dependsOn ?? []));
  const exits = fragment.resources.filter(resource => !sources.has(resource.id)).map(resource => resource.id);
  const retention = capability.family === 'storage' ? capability.properties.retention as JsonObject | undefined : undefined;
  if (retention?.onRemoval !== undefined) {
    const expected = retention.onRemoval === 'retain';
    for (const id of exits) {
      if (fragment.resources.find(resource => resource.id === id)!.lifecycle?.retainOnRemoval !== expected) {
        throw new Error('Storage retention must lower to lifecycle.retainOnRemoval on each data exit resource');
      }
    }
  }
  return { lowering: { resources: fragment.resources, internalRelations: fragment.relations }, entries, exits };
}

export interface ExpandedCapability { mapping: CapabilityMapping; resources: Resource[]; relations: Relation[] }

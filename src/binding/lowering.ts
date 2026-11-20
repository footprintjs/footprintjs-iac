import { compileGraph } from '../graph/compile.ts';
import { array, identifier, keys, object } from '../graph/data.ts';
import { readResource } from '../graph/resources.ts';
import type { Relation } from '../graph/types.ts';
import type { Capability } from '../system/types.ts';
import type { JsonObject, Resource } from '../types.ts';
import { pointerParts, pointerValue } from './pointers.ts';
import type { CapabilityAdapter, CapabilityMapping, LoweredCapability, LoweredPropertyOrigin } from './types.ts';

export function validateLowering(
  input: unknown, capability: Capability, adapter: CapabilityAdapter, allocated: Set<string>,
): { lowering: LoweredCapability; entries: string[]; exits: string[] } {
  const row = object(input as never, 'lowered capability');
  keys(row, ['resources', 'internalRelations', 'propertyOrigins'], 'lowered capability');
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
  const propertyOrigins = readPropertyOrigins(row.propertyOrigins, capability, fragment.resources);
  return { lowering: { resources: fragment.resources, internalRelations: fragment.relations, propertyOrigins }, entries, exits };
}

function readPropertyOrigins(input: unknown, capability: Capability, resources: Resource[]): LoweredPropertyOrigin[] {
  if (input === undefined) return [];
  const seen = new Set<string>();
  return array(input as never, 'lowered property origins').map(value => {
    const row = object(value, 'lowered property origin');
    keys(row, ['property', 'resourceId', 'path'], 'lowered property origin');
    const property = identifier(row.property, 'origin property');
    const resourceId = identifier(row.resourceId, 'origin resource');
    const resource = resources.find(entry => entry.id === resourceId);
    const parts = typeof row.path === 'string' && pointerParts(row.path);
    if (!Object.hasOwn(capability.properties, property) || !resource || !parts || pointerValue(resource.spec, parts) === undefined) {
      throw new Error('Lowered property origin must point to a declared property and a field in its own resource');
    }
    const path = row.path as string;
    const key = JSON.stringify([property, resourceId, path]);
    if (seen.has(key)) throw new Error('Duplicate lowered property origin');
    seen.add(key);
    return { property, resourceId, path };
  }).sort((a, b) => a.property.localeCompare(b.property) || a.resourceId.localeCompare(b.resourceId) || a.path.localeCompare(b.path));
}

export interface ExpandedCapability {
  mapping: CapabilityMapping; resources: Resource[]; relations: Relation[]; propertyOrigins: LoweredPropertyOrigin[];
}

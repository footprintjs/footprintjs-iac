import { communicationFields } from '../graph/communication.ts';
import { canonical } from '../util.ts';
import { array, identifier, jsonCopy, keys, object, text } from '../graph/data.ts';
import { readBoundary, validateBoundaryParents } from '../graph/boundaries.ts';
import { validateDependencies } from '../graph/resources.ts';
import { lexical } from '../graph/artifact.ts';
import { capabilityPath } from './references.ts';
import { readProperties } from './properties.ts';
import { inferredRelations, relationKey } from './relations.ts';
import type { Capability, CapabilityFamily, CapabilityKind, CapabilityMembership, CapabilityRelation, Principal, SystemBody } from './types.ts';

function unique(values: readonly string[], where: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${where}`);
}
export function systemBody(input: unknown): SystemBody {
  const row = object(jsonCopy(input), 'system design');
  keys(row, ['kind', 'version', 'name', 'capabilities', 'boundaries', 'memberships', 'relations', 'principals', 'digest'], 'system design');
  if (row.kind !== 'system-design' || row.version !== 1) throw new Error('Unsupported system design kind/version');
  const name = identifier(row.name, 'system name');
  const familyKinds: Record<CapabilityFamily, readonly CapabilityKind[]> = {
    compute: ['service', 'job', 'scheduled-task'], storage: ['store'], network: ['segment', 'endpoint'],
  };
  const capabilities = array(row.capabilities, 'capabilities').map(value => {
    const item = object(value, 'capability');
    keys(item, ['id', 'path', 'family', 'kind', 'properties', 'defaults'], 'capability');
    const family = item.family as CapabilityFamily, kind = item.kind as CapabilityKind;
    if (!Object.hasOwn(familyKinds, family) || !familyKinds[family].includes(kind)) throw new Error('Invalid capability family/kind');
    const properties = readProperties(item.properties, family, kind);
    const defaults = object(item.defaults!, 'capability defaults');
    for (const [key, reason] of Object.entries(defaults)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`Default reason has no property: ${key}`);
      text(reason, 'default reason');
    }
    return {
      id: identifier(item.id, 'capability id'), path: capabilityPath(item.path),
      family, kind, properties, defaults: defaults as Record<string, string>,
    } satisfies Capability;
  }).sort((a, b) => lexical(a.id, b.id));
  unique(capabilities.map(capability => capability.id), 'capability id; use stableId() to distinguish equal leaf names');
  unique(capabilities.map(capability => capability.path), 'capability path');
  const groupFamilies = new Map<string, CapabilityFamily>();
  for (const capability of capabilities) {
    const group = capability.path.split('.')[0]!;
    const old = groupFamilies.get(group);
    if (old && old !== capability.family) throw new Error('A capability group cannot mix families');
    groupFamilies.set(group, capability.family);
  }
  const principals = array(row.principals, 'principals').map(value => {
    const item = object(value, 'principal');
    keys(item, ['id', 'path', 'properties'], 'principal');
    const id = identifier(item.id, 'principal id'), path = identifier(item.path, 'principal path');
    if (id !== path) throw new Error('Principal path must equal its stable id in system-design v1');
    return { id, path, properties: object(item.properties!, 'principal properties') } satisfies Principal;
  }).sort((a, b) => lexical(a.id, b.id));
  unique(principals.map(principal => principal.id), 'principal id');
  const boundaries = array(row.boundaries, 'system boundaries').map(readBoundary).sort((a, b) => lexical(a.id, b.id));
  unique(boundaries.map(boundary => boundary.id), 'boundary id');
  validateBoundaryParents(boundaries);
  const capabilityIds = new Set(capabilities.map(capability => capability.id));
  const boundaryIds = new Set(boundaries.map(boundary => boundary.id));
  const memberships = array(row.memberships, 'system memberships').map(value => {
    const item = object(value, 'membership');
    keys(item, ['capabilityId', 'boundaryId'], 'system membership');
    const capabilityId = identifier(item.capabilityId, 'membership capability'), boundaryId = identifier(item.boundaryId, 'membership boundary');
    if (!capabilityIds.has(capabilityId) || !boundaryIds.has(boundaryId)) throw new Error('Unknown system membership endpoint');
    return { capabilityId, boundaryId } satisfies CapabilityMembership;
  }).sort((a, b) => lexical(canonical(a), canonical(b)));
  unique(memberships.map(canonical), 'system membership');
  const relations = array(row.relations, 'system relations').map(value => {
    const item = object(value, 'capability relation');
    keys(item, ['from', 'to', 'kind', 'label', 'details'], 'capability relation');
    if (item.kind !== 'dependsOn' && item.kind !== 'communicatesWith') throw new Error('Invalid capability relation kind');
    const from = identifier(item.from, 'relation source'), to = identifier(item.to, 'relation target');
    if (!capabilityIds.has(from) || !capabilityIds.has(to)) throw new Error('Unknown capability relation endpoint');
    return { from, to, kind: item.kind, ...communicationFields(item.kind, item.details), ...(item.label === undefined ? {} : { label: text(item.label, 'relation label') }) } satisfies CapabilityRelation;
  }).sort(({ details: _a, ...a }, { details: _b, ...b }) => lexical(canonical(a), canonical(b)));
  unique(relations.map(relationKey), 'capability relation');
  const required = inferredRelations(capabilities, principals);
  const present = new Set(relations.map(relationKey));
  for (const relation of required) if (!present.has(relationKey(relation))) throw new Error('System design omits a dependency/communication required by a declared use');
  validateDependencies(capabilities.map(capability => ({
    id: capability.id, provider: capability.family, spec: {},
    dependsOn: [...new Set(relations.filter(relation => relation.kind === 'dependsOn' && relation.to === capability.id).map(relation => relation.from))],
  })));
  return { kind: 'system-design', version: 1, name, capabilities, boundaries, memberships, relations, principals };
}

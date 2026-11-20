import { communicationFields } from '../graph/communication.ts';
import type { Json } from '../types.ts';
import { canonical } from '../util.ts';
import { array, identifier, jsonCopy, keys, object, text } from './data.ts';
import { readResource, validateDependencies } from './resources.ts';
import { readBoundary, validateBoundaryParents } from './boundaries.ts';
import type { GraphBody, Membership, Relation, RelationKind } from './types.ts';

const relationKinds: readonly RelationKind[] = ['order', 'data', 'communicatesWith', 'runsOn', 'assumesRole'];
export const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function relationKey(row: Relation): string { return JSON.stringify([row.from, row.to, row.kind]); }
export function isDeploymentRelation(row: Relation): boolean { return row.kind === 'order' || row.kind === 'data'; }
function unique(values: readonly string[], where: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${where}`);
}

/** Normalize semantic set ordering; validate topology without invoking any provider. */
export function graphBody(input: unknown): GraphBody {
  const row = object(jsonCopy(input), 'infra graph');
  keys(row, ['kind', 'version', 'name', 'resources', 'boundaries', 'memberships', 'relations', 'digest'], 'infra graph');
  if (row.kind !== 'infra-graph' || row.version !== 1) throw new Error('Unsupported infra graph kind/version');
  const name = identifier(row.name, 'stack name');
  const resources = array(row.resources, 'graph resources').map(readResource).sort((a, b) => lexical(a.id, b.id));
  const boundaries = array(row.boundaries, 'graph boundaries').map(readBoundary).sort((a, b) => lexical(a.id, b.id));
  unique(resources.map(resource => resource.id), 'resource id');
  unique(boundaries.map(boundary => boundary.id), 'boundary id');
  const resourceIds = new Set(resources.map(resource => resource.id));
  const boundaryIds = new Set(boundaries.map(boundary => boundary.id));
  const memberships = array(row.memberships, 'graph memberships').map(value => {
    const member = object(value, 'membership');
    keys(member, ['resourceId', 'boundaryId'], 'membership');
    const result: Membership = {
      resourceId: identifier(member.resourceId, 'membership resource'),
      boundaryId: identifier(member.boundaryId, 'membership boundary'),
    };
    if (!resourceIds.has(result.resourceId)) throw new Error(`Unknown membership resource: ${result.resourceId}`);
    if (!boundaryIds.has(result.boundaryId)) throw new Error(`Unknown membership boundary: ${result.boundaryId}`);
    return result;
  }).sort((a, b) => lexical(canonical(a), canonical(b)));
  unique(memberships.map(canonical), 'boundary membership');
  const relations = array(row.relations, 'graph relations').map(value => {
    const relation = object(value, 'relation');
    keys(relation, ['from', 'to', 'kind', 'label', 'details'], 'relation');
    if (!relationKinds.includes(relation.kind as RelationKind)) throw new Error('Invalid relation kind');
    const result: Relation = {
      from: identifier(relation.from, 'relation source'),
      to: identifier(relation.to, 'relation target'),
      kind: relation.kind as RelationKind,
      ...communicationFields(relation.kind, relation.details), ...(relation.label === undefined ? {} : { label: text(relation.label, 'relation label') }),
    };
    if (!resourceIds.has(result.from) || !resourceIds.has(result.to)) throw new Error(`Unknown relation endpoint: ${result.from} -> ${result.to}`);
    return result;
  }).sort(({ details: _a, ...a }, { details: _b, ...b }) => lexical(canonical(a), canonical(b)));
  unique(relations.map(relationKey), 'relation');
  for (const resource of resources) {
    const expected = [...new Set(relations.filter(relation => isDeploymentRelation(relation) && relation.to === resource.id).map(relation => relation.from))].sort(lexical);
    if (canonical(resource.dependsOn ?? []) !== canonical(expected)) throw new Error(`Graph relations and dependsOn disagree for ${resource.id}`);
  }
  validateDependencies(resources);
  validateBoundaryParents(boundaries);
  return { kind: 'infra-graph', version: 1, name, resources, boundaries, memberships, relations };
}

export function savedDigest(input: unknown): string {
  const row = object(jsonCopy(input), 'infra graph');
  if (typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)) throw new Error('Invalid infra graph digest');
  return row.digest;
}

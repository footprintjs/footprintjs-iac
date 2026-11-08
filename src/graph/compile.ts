import type { Resource } from '../types.ts';
import { fingerprint } from '../util.ts';
import { graphBody, isDeploymentRelation, relationKey } from './artifact.ts';
import { freeze, jsonCopy } from './data.ts';
import { readResource } from './resources.ts';
import type { Boundary, InfraGraph, Membership, Relation } from './types.ts';

export interface GraphDeclaration {
  name: string;
  resources: Resource[];
  boundaries: Boundary[];
  memberships: Membership[];
  relations: Relation[];
}

/** Compile declarations into one canonical graph used by both execution and architecture views. */
export function compileGraph(input: GraphDeclaration): InfraGraph {
  const detached = jsonCopy(input) as unknown as GraphDeclaration;
  detached.resources = detached.resources.map(readResource);
  const relations = [...detached.relations];
  const explicit = new Set<string>();
  for (const relation of relations) {
    const key = relationKey(relation);
    if (explicit.has(key)) throw new Error('Duplicate relation');
    explicit.add(key);
  }
  for (const resource of detached.resources) {
    for (const dependency of resource.dependsOn ?? []) {
      if (!relations.some(relation => isDeploymentRelation(relation) && relation.from === dependency && relation.to === resource.id)) {
        relations.push({ from: dependency, to: resource.id, kind: 'order' });
      }
    }
  }
  const resources = detached.resources.map(resource => {
    const dependsOn = [...new Set(relations.filter(relation => isDeploymentRelation(relation) && relation.to === resource.id).map(relation => relation.from))].sort();
    return { id: resource.id, provider: resource.provider, spec: resource.spec,
      ...(resource.lifecycle === undefined ? {} : { lifecycle: resource.lifecycle }), ...(dependsOn.length ? { dependsOn } : {}) };
  });
  const body = graphBody({
    kind: 'infra-graph', version: 1, name: detached.name,
    resources, boundaries: detached.boundaries, memberships: detached.memberships, relations,
  });
  return freeze({ ...body, digest: fingerprint(body) });
}

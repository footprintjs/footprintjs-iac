import { compileGraph } from '../../src/graph/compile.ts';
import type { JsonObject } from '../../src/types.ts';
import { createIdentityGraph } from './graph.ts';
import type { IdentityTarget } from './target.ts';

/** The enclosing resource flow admits identity first; this plan can mutate only Neo's consumer resources. */
export function createNeoConsumerGraph(target: IdentityTarget, connection: { endpoint: string } = { endpoint: target.issuer }) {
  const graph = createIdentityGraph(target, { includeNeo: true });
  const resources = structuredClone(graph.resources.filter(resource => !resource.id.startsWith('identity-')));
  // The binding consumes the resolved contract. Creation alone never supplies client configuration by implication.
  const app = resources.find(resource => resource.id === 'neo-app')!;
  const template = ((app.spec.spec as JsonObject).template as JsonObject).spec as JsonObject;
  const node = (template.containers as JsonObject[]).find(container => container.name === 'node')!;
  for (const variable of ['JWT_ISSUER', 'OIDC_AUTHORITY']) {
    (node.env as JsonObject[]).find(entry => entry.name === variable)!.value = connection.endpoint;
  }
  const ids = new Set(resources.map(resource => resource.id));
  return compileGraph({ name: graph.name,
    resources: resources.map(resource => ({ ...resource, ...(resource.dependsOn ? { dependsOn: resource.dependsOn.filter(id => ids.has(id)) } : {}) })),
    boundaries: graph.boundaries.filter(boundary => boundary.id === 'neo'),
    memberships: graph.memberships.filter(member => ids.has(member.resourceId)),
    relations: graph.relations.filter(relation => ids.has(relation.from) && ids.has(relation.to)),
  });
}

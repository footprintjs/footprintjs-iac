import type { Stack, StackState } from '../types.ts';
import { compileGraph } from '../graph/compile.ts';
import { assertExecutableGraph, isGraphEnvelope, validateInfraGraph } from '../graph/validation.ts';

/** Explicit cleanup retains namespaces; graph consumers keep a valid, newly synthesized envelope. */
export function cleanupStack(stack: Stack, saved: StackState): Stack {
  assertExecutableGraph(stack);
  const selected = Object.values(saved.resources).map(managed => managed.resource)
    .filter(resource => resource.provider === 'kubernetes' && resource.spec.kind === 'Namespace');
  const retained = new Set(selected.map(resource => resource.id));
  const resources = selected.map(resource => {
    const dependsOn = (resource.dependsOn ?? []).filter(id => retained.has(id));
    return { id: resource.id, provider: resource.provider, spec: resource.spec, ...(resource.lifecycle ? { lifecycle: resource.lifecycle } : {}), ...(dependsOn.length ? { dependsOn } : {}) };
  });
  if (!isGraphEnvelope(stack)) return { name: stack.name, resources };
  const graph = validateInfraGraph(stack);
  return compileGraph({
    name: graph.name, resources, boundaries: graph.boundaries,
    memberships: graph.memberships.filter(member => retained.has(member.resourceId)),
    relations: graph.relations.filter(relation => retained.has(relation.from) && retained.has(relation.to)),
  });
}

import { assertProviderChange } from './resource-change.ts';
import { providerContext, readProviderObservation } from './execution/provider-state.ts';
import { hasResourceAttributes, resolveResourceAttributes } from './resource-attributes.ts';
import { assertExecutableGraph } from './graph/validation.ts';
import { readResourceLifecycle, resolveResourceLifecycle } from './resource-lifecycle.ts';
import type { Plan, PlannedOperation, Resource, ResourceAdapter, Stack, StackState } from './types.ts';
import { fingerprint, operationId } from './util.ts';

const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function orderResources(resources: Resource[]): Resource[] {
  const byId = new Map<string, Resource>();
  for (const resource of resources) {
    if (!safeName.test(resource.id) || ['__proto__', 'constructor', 'prototype'].includes(resource.id)) {
      throw new Error(`Invalid resource id: ${resource.id}`);
    }
    readResourceLifecycle(resource.lifecycle);
    if (byId.has(resource.id)) throw new Error(`Duplicate resource: ${resource.id}`);
    if (!resource.provider || !resource.spec || Array.isArray(resource.spec)) throw new Error(`Invalid resource: ${resource.id}`);
    byId.set(resource.id, resource);
  }
  const result: Resource[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const resource = byId.get(id);
    if (!resource) throw new Error(`Unknown dependency: ${id}`);
    active.add(id);
    for (const dependency of resource.dependsOn ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
    result.push(resource);
  }
  for (const resource of resources) visit(resource.id);
  return result;
}

export async function buildPlan(
  stack: Stack, state: StackState, adapters: ReadonlyMap<string, ResourceAdapter>,
  options: { prune?: boolean } = {},
): Promise<Plan> {
  assertExecutableGraph(stack);
  if (!safeName.test(stack.name)) throw new Error(`Invalid stack name: ${stack.name}`);
  if (!Array.isArray(stack.resources)) throw new Error('Stack resources must be an array');
  if (state.stack !== stack.name) throw new Error('State belongs to another stack');
  // Validate every policy before observing providers, including in-memory saved state.
  for (const managed of Object.values(state.resources)) readResourceLifecycle(managed.resource.lifecycle);
  const ordered = orderResources(stack.resources).map(resource => {
    const lifecycle = resolveResourceLifecycle(resource.lifecycle, state.resources[resource.id]?.resource.lifecycle);
    return lifecycle === undefined ? resource : { ...resource, lifecycle };
  });
  const desiredIds = new Set(ordered.map(resource => resource.id));
  const oldResources = Object.values(state.resources).map(managed => managed.resource);
  const oldById = new Map(oldResources.map(resource => [resource.id, resource]));
  const retained = new Map<string, 'retention-policy' | 'dependency'>();
  let reverseOld: Resource[] = [];
  if (options.prune) {
    // Read the saved topology, not changed desired edges, before dispatching any observation.
    reverseOld = orderResources(oldResources).reverse();
    const roots = oldResources.filter(resource => !desiredIds.has(resource.id) && resource.lifecycle?.retainOnRemoval === true);
    for (const resource of roots) retained.set(resource.id, 'retention-policy');
    const visited = new Set<string>();
    function protect(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dependency of oldById.get(id)!.dependsOn ?? []) {
        if (!retained.has(dependency)) retained.set(dependency, 'dependency');
        protect(dependency);
      }
    }
    for (const resource of roots) protect(resource.id);
  }
  for (const [name, oldScope] of Object.entries(state.providerScopes ?? {})) {
    const scope = adapters.get(name)?.scope;
    if (scope !== oldScope) throw new Error(`Provider target changed for ${name}; use a separate state directory/stack`);
  }
  const withProviderInputs = new Set<string>();
  for (const resource of ordered) {
    const previous = state.resources[resource.id];
    if (previous && previous.resource.provider !== resource.provider) throw new Error(`Changing provider requires a new resource id: ${resource.id}`);
    if (hasResourceAttributes(resource)) withProviderInputs.add(resource.id);
    else if (previous) assertProviderChange(adapters.get(resource.provider), previous.resource, resource);
  }
  const operations: PlannedOperation[] = [];
  const byResource = new Map<string, PlannedOperation>();
  const physical = new Set<string>();
  async function inspect(resource: Resource, deleting = false): Promise<void> {
    const adapter = adapters.get(resource.provider);
    if (!adapter) throw new Error(`Unknown provider: ${resource.provider}`);
    const desiredFingerprint = fingerprint(resource.spec);
    const previous = state.resources[resource.id];
    const referenced = !deleting && withProviderInputs.has(resource.id);
    const resolvedSpec = referenced ? resolveResourceAttributes(resource, dependency => {
      const source = byResource.get(dependency)!;
      return source.action === 'create' || source.action === 'update' || source.action === 'verify' ? undefined : source.observed.attributes ?? {};
    }) : resource.spec;
    const id = operationId(stack.name, resource, deleting ? 'delete' : 'apply');
    if (resolvedSpec === undefined) {
      const operation: PlannedOperation = { resource, action: previous && previous.fingerprint ? 'update' : 'create',
        desiredFingerprint, observed: { exists: false }, operationId: id, inputResolution: { deferred: true } };
      operations.push(operation);
      byResource.set(resource.id, operation);
      return;
    }
    const concrete = referenced ? { ...resource, spec: resolvedSpec } : resource;
    if (referenced && previous) assertProviderChange(adapter, previous.resource, concrete);
    const concreteFingerprint = referenced ? fingerprint(resolvedSpec) : desiredFingerprint;
    const observed = readProviderObservation(await adapter.observe(concrete, providerContext(state, resource.id, 'plan')));
    if (observed.exists && observed.owned !== true) throw new Error(`Refusing unowned resource: ${resource.id}`);
    if (observed.physicalId && !deleting) {
      const address = `${resource.provider}:${observed.physicalId}`;
      if (physical.has(address)) throw new Error(`Duplicate physical resource: ${address}`);
      physical.add(address);
    }
    const recoveredCreate = previous?.pending?.action === 'create'
      && previous.pending.operationId === id
      && previous.pending.desiredFingerprint === concreteFingerprint
      && observed.fingerprint === concreteFingerprint;
    const action = deleting ? 'delete'
      : !observed.exists ? 'create'
      : observed.fingerprint !== concreteFingerprint || (previous && previous.fingerprint !== concreteFingerprint && !recoveredCreate) ? 'update'
      : recoveredCreate ? 'verify'
      : observed.ready === false ? 'verify' : 'noop';
    const operation = { resource, action, desiredFingerprint, observed, operationId: id,
      ...(referenced && { inputResolution: { spec: resolvedSpec } }) } satisfies PlannedOperation;
    operations.push(operation);
    byResource.set(resource.id, operation);
  }
  for (const resource of ordered) await inspect(resource);
  for (const resource of reverseOld) {
    if (!desiredIds.has(resource.id) && !retained.has(resource.id)) await inspect(resource, true);
  }
  return { stack: stack.name, operations, ...(retained.size ? {
    retained: [...retained].sort(([a], [b]) => a.localeCompare(b)).map(([resourceId, reason]) => ({ resourceId, reason })),
  } : {}) };
}

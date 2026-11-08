import { assertExecutableGraph } from './graph/validation.ts';
import { readResourceLifecycle, resolveResourceLifecycle } from './resource-lifecycle.ts';
import type { Plan, PlannedOperation, Resource, ResourceAdapter, Stack, StackState } from './types.ts';
import { fingerprint, operationId } from './util.ts';

const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Initial POST field ownership is distinct from SSA ownership. Until full migration is supported,
 * reject removals rather than accept a projection that hides an omitted-but-still-live field. */
function removedField(previous: unknown, desired: unknown, path = 'spec'): string | undefined {
  if (Array.isArray(previous)) {
    if (!Array.isArray(desired) || desired.length < previous.length) return path;
    for (let i = 0; i < previous.length; i++) {
      const oldItem = previous[i];
      const newItem = desired[i];
      if (oldItem && typeof oldItem === 'object' && !Array.isArray(oldItem)
        && typeof oldItem.name === 'string' && oldItem.name !== newItem?.name) return `${path}[${i}].name`;
      const nested = removedField(oldItem, newItem, `${path}[${i}]`);
      if (nested) return nested;
    }
  } else if (previous && typeof previous === 'object') {
    if (!desired || typeof desired !== 'object' || Array.isArray(desired)) return path;
    for (const [key, value] of Object.entries(previous)) {
      if (!Object.hasOwn(desired, key)) return `${path}.${key}`;
      const nested = removedField(value, (desired as Record<string, unknown>)[key], `${path}.${key}`);
      if (nested) return nested;
    }
  }
  return undefined;
}

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
  for (const resource of ordered) {
    const previous = state.resources[resource.id];
    if (previous && previous.resource.provider !== resource.provider) throw new Error(`Changing provider requires a new resource id: ${resource.id}`);
    // A changed physical name must never silently orphan the old resource.
    if (previous && resource.provider === 'kubernetes') {
      const identity = (r: Resource) => {
        const metadata = r.spec.metadata as Record<string, unknown> | undefined;
        return [r.spec.apiVersion, r.spec.kind, metadata?.name, metadata?.namespace ?? null];
      };
      if (fingerprint(identity(previous.resource)) !== fingerprint(identity(resource))) {
        throw new Error(`Kubernetes resource identity changed for ${resource.id}; use a new id and explicit prune`);
      }
      const removal = removedField(previous.resource.spec, resource.spec);
      if (removal) throw new Error(`Removing Kubernetes fields is unsupported in this prototype (${resource.id}: ${removal}); plan an explicit replacement with a new resource id`);
    }
  }
  const operations: PlannedOperation[] = [];
  const physical = new Set<string>();
  async function inspect(resource: Resource, deleting = false): Promise<void> {
    const adapter = adapters.get(resource.provider);
    if (!adapter) throw new Error(`Unknown provider: ${resource.provider}`);
    const desiredFingerprint = fingerprint(resource.spec);
    const observed = await adapter.observe(resource, { stack: stack.name, operationId: 'plan' });
    if (observed.exists && observed.owned !== true) throw new Error(`Refusing unowned resource: ${resource.id}`);
    if (observed.physicalId && !deleting) {
      const address = `${resource.provider}:${observed.physicalId}`;
      if (physical.has(address)) throw new Error(`Duplicate physical resource: ${address}`);
      physical.add(address);
    }
    const previous = state.resources[resource.id];
    const recoveredCreate = previous?.pending?.action === 'create'
      && previous.pending.operationId === operationId(stack.name, resource, 'apply')
      && previous.pending.desiredFingerprint === desiredFingerprint
      && observed.fingerprint === desiredFingerprint;
    const action = deleting ? 'delete'
      : !observed.exists ? 'create'
      : observed.fingerprint !== desiredFingerprint || (previous && previous.fingerprint !== desiredFingerprint && !recoveredCreate) ? 'update'
      : recoveredCreate ? 'verify'
      : observed.ready === false ? 'verify' : 'noop';
    operations.push({ resource, action, desiredFingerprint, observed, operationId: operationId(stack.name, resource, action === 'delete' ? 'delete' : 'apply') });
  }
  for (const resource of ordered) await inspect(resource);
  for (const resource of reverseOld) {
    if (!desiredIds.has(resource.id) && !retained.has(resource.id)) await inspect(resource, true);
  }
  return { stack: stack.name, operations, ...(retained.size ? {
    retained: [...retained].sort(([a], [b]) => a.localeCompare(b)).map(([resourceId, reason]) => ({ resourceId, reason })),
  } : {}) };
}

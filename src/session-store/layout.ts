import type { BindingResult } from '../binding/types.ts';
import { checkHandle, designHandles, type ServiceHandle, type StoreHandle } from '../system/handles.ts';
import { fingerprint } from '../util.ts';

export function sessionLayout(binding: BindingResult, store: StoreHandle, provider: string) {
  const handles = designHandles(binding);
  checkHandle(handles, store, true);
  const mapping = binding.mappings.find(row => row.capabilityPath === store.path && row.adapterId === provider);
  const resource = binding.graph.resources.find(row => row.id === mapping?.resourceIds[0]);
  if (store.kind !== 'store' || resource?.provider !== provider || resource.spec.kind !== 'SessionStore') {
    throw new Error('Session store belongs to a different binding adapter');
  }
  // Resource IDs already include the target. Add the system to isolate independently named apps on it.
  const namespace = 'ic_' + fingerprint({ system: binding.graph.name, resource: resource.id }).slice(0, 28);
  const readers = resource.spec.readers;
  if (!Array.isArray(readers) || !readers.every(id => typeof id === 'string')) throw new Error('Invalid session readers');
  const roles = new Map(readers.map(id => [id, 'ic_read_' + fingerprint({ namespace, id }).slice(0, 28)]));
  const maximum = resource.spec.maxLifetimeMs;
  return {
    namespace,
    roles: [...roles.values()],
    readerRole(service: ServiceHandle): string {
      checkHandle(handles, service, true);
      const mapping = binding.mappings.find(row => row.capabilityPath === service.path);
      const role = mapping && roles.get(mapping.capabilityId);
      if (service.kind !== 'service' || !role) throw new Error('Service has no declared read access to this session store');
      return role;
    },
    validateLifetime(lifetimeMs: number) {
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || (typeof maximum === 'number' && lifetimeMs > maximum)) {
        throw new Error('Session lifetime must be positive and within the declared absolute expiry');
      }
    },
  };
}

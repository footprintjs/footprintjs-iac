import { bindSystem, simulationProfile, type CapabilityAdapter } from '../../src/binding/index.ts';
import { artifact, system, type ServiceHandle, type StoreHandle } from '../../src/system/index.ts';
import type { Expiration, StorageAccess } from '../../src/system/types.ts';

export function bindSessions(adapter: CapabilityAdapter, access: StorageAccess = 'read', expiration?: Expiration) {
  let store!: StoreHandle, service!: ServiceHandle, other!: ServiceHandle;
  const app = system('session-contract');
  app.addStorage('state', storage => {
    store = expiration ? storage.sessionStore('sessions', s => s.expiration(expiration)) : storage.sessionStore('sessions');
  });
  app.addCompute('work', compute => {
    service = compute.service('api', s => s.program(artifact('app')).uses(store, access));
    other = compute.service('worker', s => s.program(artifact('app')));
  });
  // The suite tests real storage and a real database identity. It does not deploy a compute workload.
  const base = simulationProfile({ artifacts: { app: { image: 'fixture' } } });
  const binding = bindSystem(app.build(), { ...base, target: { id: 'contract-local' },
    rules: [...base.rules.filter(r => r.family === 'compute'), { id: 'sessions', family: 'storage', adapterId: adapter.id }],
    adapters: [...base.adapters, adapter] });
  return { binding, store, service, other };
}

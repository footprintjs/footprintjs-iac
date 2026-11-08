import { artifact, ref, system, type StoreBuilder } from '../src/system/index.ts';

function checkTypesOnly() {
  const store = ref.store('data.sessions');
  const network = ref.network('network.backend');
  const principal = ref.principal('api');
  system('typed').addCompute('app', c => c.addService('api', service => {
    service.program(artifact('program')).useStorage(store, { access: 'readWrite' }).useNetwork(network).runAs(principal);
    // @ts-expect-error A storage reference cannot be used as a network reference.
    service.useNetwork(store);
    // @ts-expect-error A principal reference cannot be used as a store reference.
    service.useStorage(principal, { access: 'read' });
    // @ts-expect-error Programs need opaque artifact descriptors, not provider strings.
    service.program('docker-image');
  }));
  system('typed').addStorage('data', storage => storage.addSessionStore('sessions', s => {
    s.sharing('local').durability('persistent');
    // @ts-expect-error Privacy is protection, not the sharing/visibility facet.
    s.sharing('private');
    return s;
  }));
  // @ts-expect-error Scoped callbacks are synchronous and cannot return a Promise.
  system('typed').addStorage('data', async storage => storage.addStore('sessions', (_store: StoreBuilder) => undefined));
}
void checkTypesOnly;

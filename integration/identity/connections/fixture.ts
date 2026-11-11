import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from '../../../src/providers/kubernetes.ts';
import type { Observation, Resource, ResourceAdapter } from '../../../src/types.ts';
import { canonical } from '../../../src/util.ts';
import type { IdentityTarget } from '../target.ts';

export interface IdentityEndpointObservation { id: string; name: string; running: boolean; address: string }
export interface IdentityFixtureObservation { provider: IdentityEndpointObservation; directory: IdentityEndpointObservation }

/** The sealed broker configuration must delegate credentials to this directory for every login. */
export async function assertFederationRoute(target: IdentityTarget): Promise<void> {
  try {
    const realm = JSON.parse(await readFile(join(target.directory, 'provider/neo-realm.json'), 'utf8'));
    const providers = realm.components?.['org.keycloak.storage.UserStorageProvider'];
    const component = providers?.[0], config = component?.config;
    const expected = { enabled: ['true'], importEnabled: ['false'], cachePolicy: ['NO_CACHE'],
      connectionUrl: [`ldaps://${target.directoryName}:1636`], connectionPooling: ['false'], useTruststoreSpi: ['always'] };
    if (realm.realm !== 'neo' || (realm.users !== undefined && (!Array.isArray(realm.users) || realm.users.length))
      || !Array.isArray(providers) || providers.length !== 1 || component?.providerId !== 'ldap'
      || Object.entries(expected).some(([key, value]) => canonical(config?.[key]) !== canonical(value))) throw Error();
  } catch { throw Error('federation-route-unverified'); }
}

/** Resolve only bounded public identity fields after the provider adapter validates ownership/configuration. */
export async function observeIdentityEndpoint(target: IdentityTarget, resource: Resource, stack: string,
  fixture: Pick<ResourceAdapter, 'observe'>, runner: CommandRunner): Promise<IdentityEndpointObservation> {
    const id = resource.id;
    const owned: Observation = await fixture.observe(resource, { stack, operationId: 'connection-observation' });
    if (!owned.exists || !owned.owned || !/^[a-f0-9]{64}$/.test(owned.physicalId ?? '')) throw Error('identity-ownership-unverified');
    const format = '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"address":{{json (index .NetworkSettings.Networks "kind").IPAddress}}}';
    const actual = JSON.parse((await runner('docker', ['inspect', '--format', format, owned.physicalId!], { timeoutMs: 5000 })).stdout);
    const name = String(resource.spec.name);
    if (actual.id !== owned.physicalId || actual.name !== '/' + name || typeof actual.running !== 'boolean'
      || typeof actual.address !== 'string' || (actual.running && isIP(actual.address) !== 4)
      || (actual.running && id === 'identity-provider' && target.providerAddress !== undefined
        && actual.address !== target.providerAddress)) throw Error('identity-endpoint-changed');
    return { id: actual.id, name, running: actual.running, address: actual.address };
}

export async function observeIdentityFixture(target: IdentityTarget, resources: readonly Resource[], stack: string,
  fixture: Pick<ResourceAdapter, 'observe'>, runner: CommandRunner): Promise<IdentityFixtureObservation> {
  return {
    provider: await observeIdentityEndpoint(target, resources.find(resource => resource.id === 'identity-provider')!, stack, fixture, runner),
    directory: await observeIdentityEndpoint(target, resources.find(resource => resource.id === 'identity-directory')!, stack, fixture, runner),
  };
}

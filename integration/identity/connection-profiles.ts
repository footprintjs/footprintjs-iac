import { join } from 'node:path';
import { ConnectionProfileRegistry, type ConnectionProfile, type ConnectionProfileAdapter,
  type ConnectionProfileStore, type SecretStoreAdapter } from '../../src/connection-profiles/index.ts';
import { EncryptedFileSecretStore, FileConnectionProfileStore, loadOrCreateSecretKey } from '../../src/connection-profiles/node.ts';
import type { ConnectionDetails, ResourceHandle } from '../../src/resource-flow/index.ts';
import { canonical } from '../../src/util.ts';
import { readIdentityJson } from './http.ts';
import type { IdentityTarget } from './target.ts';

export const NEO_EXISTING_IDENTITY_ADAPTER = 'neo-existing-oidc';
export interface NeoConnectionProfileStores { profiles: ConnectionProfileStore; secrets: SecretStoreAdapter }
export interface NeoConnectionProfileOptions { requestFetch?: typeof fetch; stores?: NeoConnectionProfileStores }

/** Scope admission is independent of availability, so an outage can still be measured and recorded. */
function admitExistingIdentityConfig(target: IdentityTarget, config: Readonly<Record<string, string>>): asserts config is Readonly<Record<string, string>> & { issuer: string; clientId: string; username: string } {
  if (config.issuer !== target.issuer || config.clientId !== 'neo-checks'
    || !/^[a-zA-Z0-9_.-]{1,128}$/.test(config.username ?? '')) {
    throw Error('The existing identity profile is outside this host’s approved scope');
  }
}

/** A consumer adapter: its trusted endpoint policy is deliberately confined to this local trial's source. */
export function neoExistingIdentityProfileAdapter(target: IdentityTarget, requestFetch: typeof fetch = fetch): ConnectionProfileAdapter {
  return {
    schema: { id: NEO_EXISTING_IDENTITY_ADAPTER, label: 'Existing sign-in service',
      description: 'Connect Neo to this trial’s existing identity service. The validation account proves access; its password is kept in secret storage.',
      fields: [
        { name: 'issuer', label: 'Service address', kind: 'url', required: true, description: 'The existing service’s OIDC issuer address.' },
        { name: 'clientId', label: 'Connection-check client', kind: 'text', required: true, description: 'Use the existing neo-checks client in this local trial.' },
        { name: 'username', label: 'Validation account', kind: 'text', required: true, description: 'An existing account used to test sign-in.' },
        { name: 'password', label: 'Validation password', kind: 'password', required: true, secret: true },
      ] },
    async validate({ config, secrets }) {
      // Reject browser-selected destinations before any outbound call. Generic hosts provide their own policy.
      admitExistingIdentityConfig(target, config);
      if (!secrets.password) throw Error('The existing identity credential is unavailable');
      const response = await requestFetch(config.issuer + '/.well-known/openid-configuration', {
        redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' },
      });
      const discovery = await readIdentityJson(response, 64 * 1024);
      if (response.status !== 200 || discovery.issuer !== config.issuer
        || discovery.jwks_uri !== config.issuer + '/protocol/openid-connect/certs'
        || discovery.authorization_endpoint !== config.issuer + '/protocol/openid-connect/auth'
        || discovery.token_endpoint !== config.issuer + '/protocol/openid-connect/token') {
        throw Error('The existing identity service did not confirm its endpoints');
      }
      // This trial's explicitly enabled check client uses a password grant. Neo's browser still uses PKCE.
      // Tokens and submitted credentials remain inside this adapter closure and never enter workflow scope.
      const tokenResponse = await requestFetch(discovery.token_endpoint as string, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', client_id: config.clientId, username: config.username!,
          password: secrets.password, scope: 'openid' }),
      });
      const token = await readIdentityJson(tokenResponse, 64 * 1024);
      if (tokenResponse.status !== 200 || typeof token.access_token !== 'string' || !token.access_token
        || token.access_token.length > 16 * 1024) throw Error('The existing account could not authenticate');
    },
  };
}

/** Persistent storage is composed at the host boundary, separate from the portable profile contracts. */
export async function createNeoConnectionProfiles(target: IdentityTarget, options: NeoConnectionProfileOptions = {}): Promise<ConnectionProfileRegistry> {
  let stores = options.stores;
  if (!stores) {
    const directory = join(target.directory, 'connection-secrets');
    stores = { profiles: new FileConnectionProfileStore(join(target.directory, 'connection-profiles')),
      secrets: new EncryptedFileSecretStore({ directory, key: await loadOrCreateSecretKey(directory), id: 'neo-local-' + target.id }) };
  }
  return new ConnectionProfileRegistry({ ...stores, adapters: [neoExistingIdentityProfileAdapter(target, options.requestFetch)] });
}

export function neoRegisteredConnectionDetails(target: IdentityTarget, resource: ResourceHandle, profile: ConnectionProfile): ConnectionDetails {
  if (profile.adapterId !== NEO_EXISTING_IDENTITY_ADAPTER) {
    throw Error('The selected profile does not identify the approved existing service');
  }
  admitExistingIdentityConfig(target, profile.config);
  return { profileId: profile.id, resourceId: resource.id, endpoint: profile.config.issuer,
    protocol: 'oidc', credentialRef: 'profile-' + profile.id, trustRef: 'neo-ldap-trust-' + target.id };
}

export async function assertNeoRegisteredConnection(registry: ConnectionProfileRegistry, target: IdentityTarget,
  resource: ResourceHandle, details: ConnectionDetails, selectedProfileId?: string): Promise<void> {
  if (selectedProfileId !== undefined && selectedProfileId !== details.profileId) throw Error('The selected existing connection profile changed');
  const { profile } = await registry.resolve(details.profileId);
  if (canonical(details) !== canonical(neoRegisteredConnectionDetails(target, resource, profile))) {
    throw Error('The selected existing connection profile changed');
  }
}

/** Read-only reference admission for rechecks. Actual check adapters report reachability/auth failures. */
export async function assertNeoRegisteredConnectionReference(registry: ConnectionProfileRegistry, target: IdentityTarget,
  resource: ResourceHandle, details: ConnectionDetails, selectedProfileId?: string): Promise<void> {
  if (selectedProfileId !== undefined && selectedProfileId !== details.profileId) throw Error('The selected existing connection profile changed');
  const profile = await registry.get(details.profileId);
  if (!profile || canonical(details) !== canonical(neoRegisteredConnectionDetails(target, resource, profile))) {
    throw Error('The selected existing connection profile changed');
  }
}

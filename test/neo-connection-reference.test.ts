import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionProfileRegistry, MemoryConnectionProfileStore, MemorySecretStore } from '../src/connection-profiles/index.ts';
import { assertNeoRegisteredConnection, assertNeoRegisteredConnectionReference, neoExistingIdentityProfileAdapter,
  neoRegisteredConnectionDetails } from '../integration/identity/connection-profiles.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';

const target = { id: '1234abcd', issuer: 'https://approved.identity.example/realms/neo' } as IdentityTarget;
const resource = { id: 'neo-identity-' + target.id, kind: 'identity-service', scope: 'approved-target-scope', physicalId: 'owned-source-identity' };
const schema = neoExistingIdentityProfileAdapter(target).schema;
const registration = { adapterId: schema.id, label: 'Existing identity',
  config: { issuer: target.issuer, clientId: 'neo-checks', username: 'alice' }, secrets: { password: 'private-validation-secret' } };

test('reference admission preserves scope checks during outages without resolving secrets or authenticating', async () => {
  let available = true, authentications = 0, secretReads = 0;
  const secrets = new MemorySecretStore(), get = secrets.get.bind(secrets);
  secrets.get = async reference => { secretReads++; return get(reference); };
  const registry = new ConnectionProfileRegistry({ profiles: new MemoryConnectionProfileStore(), secrets,
    adapters: [{ schema, validate() { authentications++; if (!available) throw Error('The approved service is unavailable'); } }] });
  const profile = await registry.register(registration), details = neoRegisteredConnectionDetails(target, resource, profile);
  available = false;
  await assert.rejects(assertNeoRegisteredConnection(registry, target, resource, details, profile.id));
  const before = { authentications, secretReads };
  await assertNeoRegisteredConnectionReference(registry, target, resource, details, profile.id);
  assert.deepEqual({ authentications, secretReads }, before);
  await assert.rejects(assertNeoRegisteredConnectionReference(registry, target, resource, details, 'another-profile'));
  await assert.rejects(assertNeoRegisteredConnectionReference(registry, target, resource, { ...details, endpoint: 'https://another.example' }, profile.id));
});

test('reference-only admission rejects a substituted issuer, check client or account before any availability check', async () => {
  // Storage/schema admission alone does not establish the consumer's stricter endpoint policy.
  const registry = new ConnectionProfileRegistry({ profiles: new MemoryConnectionProfileStore(), secrets: new MemorySecretStore(), adapters: [{ schema }] });
  for (const config of [
    { ...registration.config, issuer: 'http://169.254.169.254/metadata' },
    { ...registration.config, clientId: 'another-client' },
    { ...registration.config, username: '../unapproved-account' },
  ]) {
    const profile = await registry.register({ ...registration, config });
    const details = { profileId: profile.id, resourceId: resource.id, endpoint: config.issuer, protocol: 'oidc',
      credentialRef: 'profile-' + profile.id, trustRef: 'neo-ldap-trust-' + target.id };
    await assert.rejects(assertNeoRegisteredConnectionReference(registry, target, resource, details, profile.id));
  }
});

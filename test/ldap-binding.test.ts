import test from 'node:test';
import assert from 'node:assert/strict';
import { defineIdentitySource } from '../src/identity/index.ts';
import { LdapIdentityAdapter, type LdapBindingOptions } from '../src/identity-ldap/index.ts';

const source = defineIdentitySource({ id: 'company-directory', kind: 'directory' });
const options: LdapBindingOptions = { url: 'ldaps://directory.example.test:636', usersDn: 'ou=people,dc=example,dc=test',
  groupsDn: 'ou=groups,dc=example,dc=test', bindDn: 'cn=reader,dc=example,dc=test',
  bindSecret: { environment: 'DIRECTORY_BIND_PASSWORD' }, trust: { certificatePath: '/trust/company-ca.pem' } };

test('LDAP binding is immutable intent with a runtime secret reference, not permission grants', () => {
  const binding = new LdapIdentityAdapter().bind(source, options);
  assert.equal(source.ownership, 'external');
  assert.equal(binding.sourceId, source.id);
  assert.ok(Object.isFrozen(binding.component));
  const text = JSON.stringify(binding);
  assert.ok(text.includes('${DIRECTORY_BIND_PASSWORD}'));
  assert.ok(!text.includes('providerType'), 'Keycloak realm import has component export fields, not admin API fields');
  assert.ok(!text.includes('rules'));
  assert.throws(() => { (binding.component as Record<string, unknown>).name = 'changed'; });
  assert.equal(options.url, 'ldaps://directory.example.test:636');
});

test('LDAP binding rejects plaintext, embedded credentials and unknown secret-bearing fields', () => {
  for (const url of ['ldap://directory.example.test', 'ldaps://user:password@directory.example.test', 'ldaps://directory.example.test/?password=secret']) {
    assert.throws(() => new LdapIdentityAdapter().bind(source, { ...options, url }));
  }
  assert.throws(() => new LdapIdentityAdapter().bind(source, { ...options, bindSecret: { environment: 'PASSWORD', password: 'never-capture-this' } } as unknown as LdapBindingOptions));
  assert.throws(() => new LdapIdentityAdapter().bind(source, { ...options, trust: { certificatePath: '/trust/ca', skipVerification: true } } as unknown as LdapBindingOptions));
  let invoked = false;
  const accessor = { ...options };
  Object.defineProperty(accessor, 'url', { enumerable: true, get() { invoked = true; return options.url; } });
  assert.throws(() => new LdapIdentityAdapter().bind(source, accessor));
  assert.equal(invoked, false);
});

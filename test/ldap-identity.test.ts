import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { InvalidCredentialsError, type ClientOptions, type SearchOptions, type SearchResult } from 'ldapts';
import { checkIdentityAccess, defineIdentitySource } from '../src/identity/index.ts';
import { LdapSourceAdapter, type LdapClient, type LdapSourceOptions } from '../src/identity-ldap/index.ts';

let directory: string, certificate: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'iac-ldap-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=directory.local',
    '-addext', 'subjectAltName=DNS:directory.local', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  certificate = await readFile(join(directory, 'cert.pem'), 'utf8');
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const userDn = 'uid=alice,ou=people,dc=example,dc=org';
const uuid = 'f52ea671-d9c6-4985-a31a-a87b65b9d461';
const users = (): SearchResult => ({ searchEntries: [{ dn: userDn, uid: 'alice', entryUUID: uuid }], searchReferences: [] });
const groups = (): SearchResult => ({ searchEntries: [{ dn: 'cn=neo-readers,ou=groups,dc=example,dc=org', cn: 'neo-readers' }], searchReferences: [] });
function options(): LdapSourceOptions {
  return { source: defineIdentitySource({ id: 'neo-directory', kind: 'directory' }), url: 'ldaps://127.0.0.1:1636',
    usersDn: 'ou=people,dc=example,dc=org', groupsDn: 'ou=groups,dc=example,dc=org', bindDn: 'cn=reader,dc=example,dc=org',
    ca: certificate, serverName: 'directory.local', resolveBindPassword: async () => 'service-private-password' };
}
interface Behavior { serviceBind?: unknown; userBind?: unknown; userSearch?: unknown; groupSearch?: unknown; users?: SearchResult; groups?: SearchResult; close?: unknown }
function harness(behavior: Behavior = {}, config = options()) {
  const clientOptions: ClientOptions[] = [], binds: { client: number; dn: string; password: string }[] = [];
  const searches: { client: number; base: string; options: SearchOptions }[] = [], closed: number[] = [];
  const adapter = new LdapSourceAdapter(config, input => {
    const index = clientOptions.length; clientOptions.push(input); const service = index % 2 === 0;
    const client: LdapClient = {
      async bind(dn, password) {
        binds.push({ client: index, dn, password }); const error = service ? behavior.serviceBind : behavior.userBind;
        if (error) throw error;
      },
      async search(base, search) {
        searches.push({ client: index, base, options: search }); const isUser = base.startsWith('ou=people');
        const error = isUser ? behavior.userSearch : behavior.groupSearch; if (error) throw error;
        return isUser ? behavior.users ?? users() : behavior.groups ?? groups();
      },
      async unbind() { closed.push(index); if (behavior.close) throw behavior.close; },
    };
    return client;
  });
  return { adapter, clientOptions, binds, searches, closed };
}

test('LDAP verifies a unique user bind and reads groups with service identity using fresh strict TLS clients', async () => {
  const configuration = options(), live = harness({}, configuration);
  (configuration as { url: string }).url = 'ldaps://changed.example.org';
  const first = await live.adapter.authenticate({ username: 'alice', password: 'user-private-password' });
  assert.deepEqual(first, { status: 'authenticated', subject: { id: uuid, source: 'neo-directory', groups: ['neo-readers'] } });
  assert.deepEqual(live.binds.map(value => [value.client, value.dn]), [[0, 'cn=reader,dc=example,dc=org'], [1, userDn]]);
  assert.deepEqual(live.searches.map(value => value.client), [0, 0]);
  assert.deepEqual(live.searches[0]!.options.attributes, ['uid', 'entryUUID']);
  assert.deepEqual(live.searches[1]!.options.attributes, ['cn']);
  for (const input of live.clientOptions) {
    assert.equal(input.url, 'ldaps://127.0.0.1:1636');
    assert.equal(input.timeout, 3000); assert.equal(input.connectTimeout, 3000); assert.equal(input.autoRebind, false);
    assert.equal(input.tlsOptions!.rejectUnauthorized, true); assert.equal(input.tlsOptions!.minVersion, 'TLSv1.2');
    assert.equal(input.tlsOptions!.ca, certificate); assert.equal(input.tlsOptions!.servername, 'directory.local');
  }
  assert.deepEqual(live.closed.sort(), [0, 1]);
  assert.ok(Object.isFrozen(first));
  await live.adapter.authenticate({ username: 'alice', password: 'user-private-password' });
  assert.equal(live.clientOptions.length, 4);
  const text = JSON.stringify(first); assert.ok(!text.includes('password')); assert.ok(!text.includes('service-private'));
});

test('only invalid credentials at the user bind are rejection; infrastructure and group failures stay unavailable', async () => {
  const badPassword = harness({ userBind: new InvalidCredentialsError('user-private-password') });
  assert.deepEqual(await badPassword.adapter.authenticate({ username: 'alice', password: 'wrong-password' }), { status: 'rejected', code: 'invalid-credentials' });
  for (const behavior of [{ serviceBind: new InvalidCredentialsError('service-private-password') },
    { userSearch: new InvalidCredentialsError('raw-directory-error') }, { groupSearch: new InvalidCredentialsError('raw-directory-error') }]) {
    const live = harness(behavior);
    assert.deepEqual(await live.adapter.authenticate({ username: 'alice', password: 'password' }), { status: 'unavailable', code: 'backend-error' });
    assert.ok(live.closed.length > 0);
  }
});

test('LDAP username and membership filters escape injection characters before directory searches', async () => {
  const specialDn = 'uid=alice(test)\\name,ou=people,dc=example,dc=org';
  const live = harness({ users: { searchEntries: [{ dn: specialDn, uid: 'alice', entryUUID: uuid }], searchReferences: [] } });
  await live.adapter.authenticate({ username: 'alice*)(uid=*)\\name', password: 'password' });
  assert.equal(live.searches[0]!.options.filter, '(&(objectClass=inetOrgPerson)(uid=alice\\2a\\29\\28uid=\\2a\\29\\5cname))');
  assert.equal(live.searches[1]!.options.filter, '(&(objectClass=groupOfNames)(member=uid=alice\\28test\\29\\5cname,ou=people,dc=example,dc=org))');
  assert.equal(live.searches[0]!.options.sizeLimit, 2); assert.equal(live.searches[0]!.options.derefAliases, 'never');
});

test('ambiguous identities, referrals, malformed stable IDs and unreadable groups never authenticate', async () => {
  for (const behavior of [
    { users: { searchEntries: [...users().searchEntries, ...users().searchEntries], searchReferences: [] } },
    { users: { ...users(), searchReferences: ['ldaps://foreign-directory'] } },
    { users: { searchEntries: [{ dn: userDn, uid: 'alice', entryUUID: 'unstable-or-missing' }], searchReferences: [] } },
    { groups: { searchEntries: [{ dn: 'cn=empty,ou=groups,dc=example,dc=org', cn: [] }], searchReferences: [] } },
    { groups: { ...groups(), searchReferences: ['ldaps://foreign-directory'] } },
  ]) {
    const live = harness(behavior);
    assert.equal((await live.adapter.authenticate({ username: 'alice', password: 'password' })).status, 'unavailable');
  }
  const missing = harness({ users: { searchEntries: [], searchReferences: [] } });
  assert.deepEqual(await missing.adapter.authenticate({ username: 'absent', password: 'password' }), { status: 'rejected', code: 'invalid-credentials' });
});

test('empty credentials never invoke anonymous binds, while TLS and transport errors preserve safe classifications', async () => {
  const live = harness();
  for (const credential of [{ username: 'alice', password: '' }, { username: '', password: 'password' }, { username: ' alice', password: 'password' }]) {
    assert.equal((await live.adapter.authenticate(credential)).status, 'rejected');
  }
  assert.equal(live.clientOptions.length, 0);
  for (const [code, expected] of [['ECONNREFUSED', 'connection-refused'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls-error'], ['CERT_HAS_EXPIRED', 'tls-error'], ['ETIMEDOUT', 'transport-failure']]) {
    const failed = harness({ serviceBind: Object.assign(new Error('raw-secret-password'), { code }), close: new Error('raw-close-secret') });
    assert.deepEqual(await failed.adapter.authenticate({ username: 'alice', password: 'password' }), { status: 'unavailable', code: expected });
  }
  const emptyService = harness({}, { ...options(), resolveBindPassword: async () => '' });
  assert.deepEqual(await emptyService.adapter.authenticate({ username: 'alice', password: 'password' }), { status: 'unavailable', code: 'backend-error' });
  assert.equal(emptyService.clientOptions.length, 0);
});

test('LDAP admission rejects insecure endpoints, missing trust, hidden credentials and accessors without invoking them', () => {
  for (const changes of [{ url: 'ldap://directory.local' }, { url: 'ldaps://user:password@directory.local' },
    { url: 'ldaps://directory.local/path' }, { url: 'ldaps://directory.local?query' }, { ca: 'not-a-certificate' },
    { password: 'embedded-secret' }, { serverName: 'directory.local/path' }]) assert.throws(() => harness({}, { ...options(), ...changes }));
  let reads = 0;
  assert.throws(() => harness({}, { ...options(), get url() { reads++; return 'ldaps://directory.local'; } }), /accessors/);
  assert.equal(reads, 0);
});

test('LDAP credentials and provider exception bodies stay outside FootPrint snapshots and JSONL traces', async () => {
  const canary = 'ldap-credential-do-not-record-977';
  const live = harness({ userBind: new InvalidCredentialsError(canary) });
  const run = await checkIdentityAccess({ stack: 'ldap-check', traceDirectory: directory,
    checks: [{ id: 'bad-password', label: 'Invalid credentials refused', kind: 'login', expected: 'rejected' }],
    adapter: { async check() {
      const result = await live.adapter.authenticate({ username: 'alice', password: canary });
      return { verdict: result.status === 'rejected' ? 'rejected' : 'unavailable', observedAt: Date.now(), latencyMs: 1,
        details: { code: result.status === 'rejected' ? 'invalid-credentials' : 'backend-error' } };
    } } });
  assert.equal(run.ok, true);
  assert.ok(!JSON.stringify(run).includes(canary));
  assert.ok(!(await readFile(run.tracePath!, 'utf8')).includes(canary));
});

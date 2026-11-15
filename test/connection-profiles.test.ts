import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fingerprint } from '../src/util.ts';
import { ConnectionProfileRegistry, MemoryConnectionProfileStore, MemorySecretStore, ConnectionProfileError,
  readConnectionAdapterSchema, readConnectionProfile, CONNECTION_PROFILE_CAPACITY,
  type ConnectionProfile, type ConnectionProfileAdapter, type ConnectionProfileRegistration } from '../src/connection-profiles/index.ts';
import { EncryptedFileSecretStore, FileConnectionProfileStore, loadOrCreateSecretKey } from '../src/connection-profiles/node.ts';

const password = 'private-credential-for-tests-8b9349';
const schema = { id: 'existing-service', label: 'Existing service', fields: [
  { name: 'endpoint', label: 'Address', kind: 'url' as const, required: true },
  { name: 'port', label: 'Port', kind: 'integer' as const },
  { name: 'username', label: 'Account', kind: 'text' as const, required: true },
  { name: 'password', label: 'Password', kind: 'password' as const, secret: true, required: true },
] };
const registration = (): ConnectionProfileRegistration => ({ label: 'Company directory', adapterId: schema.id,
  config: { endpoint: 'https://directory.company.example', username: 'reader', port: '443' }, secrets: { password } });
function memory(adapters: ConnectionProfileAdapter[] = [{ schema }]) {
  const profiles = new MemoryConnectionProfileStore(), secrets = new MemorySecretStore();
  return { profiles, secrets, registry: new ConnectionProfileRegistry({ profiles, secrets, adapters }) };
}
function code(expected: string) { return (error: unknown) => error instanceof ConnectionProfileError && error.code === expected; }

test('profiles separate secret input, remain immutable, and resolve through pluggable adapters', async () => {
  let calls = 0;
  const { registry, profiles, secrets } = memory([{ schema, validate(input) {
    calls++; assert.equal(input.secrets.password, password); assert.equal(input.config.endpoint, registration().config.endpoint);
    assert.equal(Object.isFrozen(input.secrets), true);
  } }]);
  const input = registration(), saved = await registry.register(input); input.config.endpoint = 'https://changed.example';
  assert.equal(calls, 1); assert.equal(saved.version, 1); assert.equal(saved.revision, 1); assert.ok(saved.secretRefs.password);
  assert.equal(saved.config.endpoint, registration().config.endpoint);
  assert.equal(JSON.stringify(saved).includes(password), false);
  assert.equal(JSON.stringify(await registry.list()).includes(password), false);
  assert.equal(JSON.stringify(secrets).includes(password), false);
  assert.equal(Object.isFrozen(saved.config), true);
  await assert.rejects(profiles.put(saved), code('profile-conflict'));
  assert.equal((await registry.resolve(saved.id)).secrets.password, password);
  assert.equal(calls, 2); assert.deepEqual(await registry.test(saved.id), { profileId: saved.id, ok: true });
  const revised = await registry.revise(saved.id, { ...registration(), label: 'Company directory next' });
  assert.notEqual(saved.id, revised.id); assert.equal(revised.revision, 2); assert.equal(revised.previousId, saved.id);
  assert.equal((await registry.get(saved.id))?.label, 'Company directory');
  assert.equal((await registry.list()).length, 2);
});

test('schema validation rejects misplaced secrets, unknown inputs, URL credentials and malformed fields before adapter calls', async () => {
  let calls = 0; const { registry } = memory([{ schema, validate() { calls++; } }]);
  for (const bad of [
    { ...registration(), config: { ...registration().config, password } },
    { ...registration(), secrets: { password, endpoint: 'https://wrong.example' } },
    { ...registration(), config: { ...registration().config, unknown: 'anything' } },
    { ...registration(), config: { ...registration().config, endpoint: 'https://reader:secret@company.example' } },
    { ...registration(), config: { ...registration().config, endpoint: 'https://company.example?token=secret' } },
    { ...registration(), config: { ...registration().config, port: '4.5' } },
    { ...registration(), secrets: {} },
  ]) await assert.rejects(registry.register(bad as ConnectionProfileRegistration), code('invalid-registration'));
  assert.equal(calls, 0);
  await assert.rejects(registry.register({ ...registration(), adapterId: 'unapproved' }), code('unsupported-adapter'));
  await assert.rejects(registry.register({ ...registration(), label: 'x'.repeat(161) }), code('invalid-registration'));
  assert.throws(() => readConnectionAdapterSchema({ ...schema, fields: [{ name: 'password', label: 'Password', kind: 'password' }] }), code('invalid-schema'));
  let touched = false;
  const accessor = { ...registration(), get secrets() { touched = true; return { password }; } };
  await assert.rejects(registry.register(accessor), code('invalid-registration')); assert.equal(touched, false);
});

test('provider failure messages and credential values never escape registration or connection tests', async () => {
  let healthy = true;
  const { registry } = memory([{ schema, validate() { if (!healthy) throw Error('remote says password=' + password); } }]);
  const saved = await registry.register(registration()); healthy = false;
  await assert.rejects(registry.register(registration()), error => {
    assert.equal(String(error).includes(password), false); assert.equal((error as Error).cause, undefined);
    return code('connection-check-failed')(error);
  });
  assert.deepEqual(await registry.test(saved.id), { profileId: saved.id, ok: false, code: 'connection-check-failed' });
  healthy = true; assert.equal((await registry.test(saved.id)).ok, true);
});

test('class adapter validation keeps its original receiver on registration and resolution', async () => {
  class CompanyAdapter implements ConnectionProfileAdapter {
    readonly schema = schema;
    readonly expected = registration().config.endpoint;
    calls = 0;
    validate(input: { config: Readonly<Record<string, string>> }) {
      this.calls++; if (input.config.endpoint !== this.expected) throw Error('Wrong endpoint');
    }
  }
  const adapter = new CompanyAdapter(), { registry } = memory([adapter]);
  const saved = await registry.register(registration()); await registry.resolve(saved.id);
  assert.equal((await registry.test(saved.id)).ok, true); assert.equal(adapter.calls, 3);
});

test('registration cleans newly allocated secrets after durable profile publication fails', async () => {
  const secrets = new MemorySecretStore(); let allocated = '';
  const put = secrets.put.bind(secrets); secrets.put = async value => { allocated = await put(value); return allocated; };
  const registry = new ConnectionProfileRegistry({ adapters: [{ schema }], secrets,
    profiles: { async list() { return []; }, async get() { return undefined; }, async put() { throw Error(password); } } });
  await assert.rejects(registry.register(registration()), code('storage-unavailable')); assert.ok(allocated);
  assert.equal(await secrets.get(allocated), undefined);
});

test('schema-only adapters never report a connection probe as passed', async () => {
  const { registry } = memory(); const saved = await registry.register(registration());
  assert.deepEqual(await registry.test(saved.id), { profileId: saved.id, ok: false, code: 'connection-check-unavailable' });
  assert.equal((await registry.resolve(saved.id)).secrets.password, password);
});

test('external secret-store references stay opaque and a broken adapter cannot return plaintext as a reference', async () => {
  const profiles = new MemoryConnectionProfileStore();
  const registry = new ConnectionProfileRegistry({ adapters: [{ schema }], profiles, secrets: { id: 'company-vault',
    async put() { return 'vault://company/team/existing-directory/password#version=4'; },
    async get() { return password; }, async delete() {},
  } });
  const saved = await registry.register(registration());
  assert.equal(saved.secretRefs.password, 'vault://company/team/existing-directory/password#version=4');
  assert.equal((await registry.resolve(saved.id)).secrets.password, password);
  const broken = new ConnectionProfileRegistry({ adapters: [{ schema }], profiles: new MemoryConnectionProfileStore(), secrets: { id: 'broken',
    async put(value) { return value; }, async get() { return password; }, async delete() {},
  } });
  await assert.rejects(broken.register(registration()), code('storage-unavailable'));
});

test('registry rejects a store rebinding the requested ID or leaking storage error details', async () => {
  const { registry: original } = memory(), saved = await original.register(registration());
  const mismatched = new ConnectionProfileRegistry({ adapters: [{ schema }], secrets: new MemorySecretStore(), profiles: {
    async list() { return [saved, saved]; }, async get() { return saved; }, async put() {},
  } });
  await assert.rejects(mismatched.get('cp-another-id'), code('invalid-profile'));
  await assert.rejects(mismatched.list(), code('invalid-profile'));
  const throwing = new ConnectionProfileRegistry({ adapters: [{ schema }], secrets: new MemorySecretStore(), profiles: {
    async list() { throw Error(password); }, async get() { throw Error(password); }, async put() {},
  } });
  await assert.rejects(throwing.get(saved.id), error => !String(error).includes(password) && code('storage-unavailable')(error));
  await assert.rejects(throwing.list(), error => !String(error).includes(password) && code('storage-unavailable')(error));
});

test('registration reconciles publication after uncertain completion without deleting referenced credentials', async () => {
  const profiles = new MemoryConnectionProfileStore(), secrets = new MemorySecretStore();
  const put = profiles.put.bind(profiles); profiles.put = async value => { await put(value); throw Error('lost acknowledgement'); };
  const registry = new ConnectionProfileRegistry({ adapters: [{ schema }], secrets, profiles });
  const saved = await registry.register(registration());
  assert.equal((await registry.resolve(saved.id)).secrets.password, password);
});

test('encrypted local adapters persist across restart without plaintext secrets and detect tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-connections-'));
  try {
    const keyDirectory = join(directory, 'keys'), key = await loadOrCreateSecretKey(keyDirectory);
    assert.deepEqual(await loadOrCreateSecretKey(keyDirectory), key);
    const profileDirectory = join(directory, 'profiles'), secretDirectory = join(directory, 'secrets');
    const profiles = new FileConnectionProfileStore(profileDirectory), secrets = new EncryptedFileSecretStore({ directory: secretDirectory, key });
    const registry = new ConnectionProfileRegistry({ adapters: [{ schema }], profiles, secrets });
    const saved = await registry.register(registration());
    const restarted = new ConnectionProfileRegistry({ adapters: [{ schema }], profiles: new FileConnectionProfileStore(profileDirectory),
      secrets: new EncryptedFileSecretStore({ directory: secretDirectory, key: await loadOrCreateSecretKey(keyDirectory) }) });
    assert.equal((await restarted.resolve(saved.id)).secrets.password, password);
    assert.equal((await stat(profileDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(keyDirectory, 'master.key'))).mode & 0o777, 0o600);
    for (const folder of [profileDirectory, secretDirectory]) for (const name of await readdir(folder)) {
      if (name === '.locks') continue;
      assert.equal((await readFile(join(folder, name), 'utf8')).includes(password), false);
      assert.equal((await stat(join(folder, name))).mode & 0o777, 0o600);
    }
    assert.equal(JSON.stringify(secrets).includes(Buffer.from(key).toString('base64')), false);
    await assert.rejects(profiles.put(saved), code('profile-conflict'));
    const badKey = new EncryptedFileSecretStore({ directory: secretDirectory, key: randomBytes(32) });
    await assert.rejects(badKey.get(saved.secretRefs.password!), code('secret-unavailable'));
    const secretFile = join(secretDirectory, (await readdir(secretDirectory))[0]!);
    const envelope = JSON.parse(await readFile(secretFile, 'utf8')); envelope.tag = randomBytes(16).toString('base64');
    await writeFile(secretFile, JSON.stringify(envelope), { mode: 0o600 });
    await assert.rejects(secrets.get(saved.secretRefs.password!), code('secret-unavailable'));
    const altered = JSON.parse(JSON.stringify(saved)); altered.config.endpoint = 'https://substituted.example';
    assert.throws(() => readConnectionProfile(altered), code('invalid-profile'));
    await writeFile(join(profileDirectory, saved.id + '.json'), JSON.stringify(altered), { mode: 0o600 });
    await assert.rejects(restarted.get(saved.id), code('invalid-profile'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private local stores reject traversal, symlink files/directories and public permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-connections-private-'));
  try {
    const profiles = new FileConnectionProfileStore(join(directory, 'profiles'));
    await assert.rejects(profiles.get('../master.key'), code('invalid-profile'));
    await profiles.list(); const outside = join(directory, 'outside'); await writeFile(outside, '{}', { mode: 0o600 });
    await symlink(outside, join(directory, 'profiles', 'linked.json'));
    await assert.rejects(profiles.get('linked'), code('storage-unavailable'));
    await symlink(join(directory, 'profiles'), join(directory, 'linked-directory'));
    await assert.rejects(new FileConnectionProfileStore(join(directory, 'linked-directory')).list(), code('storage-unavailable'));
    await chmod(join(directory, 'profiles'), 0o755);
    await assert.rejects(profiles.list(), code('storage-unavailable'));
    const store = new EncryptedFileSecretStore({ directory: join(directory, 'secrets'), key: randomBytes(32) });
    await assert.rejects(store.get('secret:local:../../outside'), code('secret-unavailable'));
    const reference = await store.put(password), name = reference.split(':')[2]! + '.json';
    await chmod(join(directory, 'secrets', name), 0o644);
    await assert.rejects(store.get(reference), code('storage-unavailable'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent local writes never rebind a profile identifier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-connections-race-'));
  try {
    const saved = await memory().registry.register(registration());
    const first = new FileConnectionProfileStore(join(directory, 'profiles')), second = new FileConnectionProfileStore(join(directory, 'profiles'));
    const outcomes = await Promise.allSettled([first.put(saved), second.put(saved)]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected' && code('profile-conflict')(outcome.reason)).length, 1);
    assert.deepEqual(await first.get(saved.id), saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function fixtureProfile(index: number): ConnectionProfile {
  const definition = { version: 1 as const, id: 'cp-capacity-' + index, label: 'Saved connection ' + index,
    adapterId: schema.id, revision: 1, config: registration().config, secretRefs: { password: 'opaque-reference-' + index } };
  return readConnectionProfile({ ...definition, digest: fingerprint(definition) });
}

test('registration admits exactly the remaining slot and rejects capacity before probes or secret allocation', async () => {
  const profiles = new MemoryConnectionProfileStore(), secrets = new MemorySecretStore();
  for (let index = 0; index < CONNECTION_PROFILE_CAPACITY - 1; index++) await profiles.put(fixtureProfile(index));
  let probes = 0, allocations = 0, deletions = 0;
  const put = secrets.put.bind(secrets), remove = secrets.delete.bind(secrets);
  secrets.put = async value => { allocations++; return put(value); };
  secrets.delete = async reference => { deletions++; await remove(reference); };
  const registry = new ConnectionProfileRegistry({ profiles, secrets, adapters: [{ schema, validate() { probes++; } }] });
  const race = await Promise.allSettled([registry.register(registration()), registry.register(registration())]);
  assert.equal(race.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(race.filter(value => value.status === 'rejected' && code('profile-capacity')(value.reason)).length, 1);
  assert.equal((await registry.list()).length, CONNECTION_PROFILE_CAPACITY);
  assert.equal(allocations - deletions, 1);
  const before = { probes, allocations };
  await assert.rejects(registry.register(registration()), code('profile-capacity'));
  assert.deepEqual({ probes, allocations }, before);
  assert.equal((await registry.get('cp-capacity-0'))?.id, 'cp-capacity-0');
  const completed = race.find(value => value.status === 'fulfilled'); assert.ok(completed?.status === 'fulfilled');
  assert.equal((await registry.resolve(completed.value.id)).secrets.password, password);
});

test('separate local file stores atomically enforce the last catalog slot without evicting saved revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-connections-capacity-'));
  try {
    const folder = join(directory, 'profiles'), first = new FileConnectionProfileStore(folder), second = new FileConnectionProfileStore(folder);
    await first.list();
    await Promise.all(Array.from({ length: CONNECTION_PROFILE_CAPACITY - 1 }, async (_, index) => {
      const profile = fixtureProfile(index);
      await writeFile(join(folder, profile.id + '.json'), JSON.stringify(profile), { mode: 0o600 });
    }));
    const outcomes = await Promise.allSettled([first.put(fixtureProfile(1000)), second.put(fixtureProfile(1001))]);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(value => value.status === 'rejected' && code('profile-capacity')(value.reason)).length, 1);
    assert.equal((await second.list()).length, CONNECTION_PROFILE_CAPACITY);
    assert.equal((await second.get('cp-capacity-0'))?.id, 'cp-capacity-0');
    await assert.rejects(first.put(fixtureProfile(1002)), code('profile-capacity'));
    assert.equal((await first.list()).length, CONNECTION_PROFILE_CAPACITY);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

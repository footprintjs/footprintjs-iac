import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../src/util.ts';
import {
  FixedHostDiscovery, HOST_INVENTORY_ACTION, HOST_INVENTORY_ACTION_DIGEST, HostAccessError, LocalHostAccessTransport,
  createSshHostAccessTransport, hostActionDigest, hostFactsDigest, readHostFactsSnapshot, readHostInventoryOutput,
  HostDiscoveryRegistry,
  type HostAction, type HostProcessRequest,
} from '../src/platform-access/index.ts';

const host = { id: 'server-a', scope: 'owned-server-scope', profileId: 'management-profile-a' };
const context = { executionId: 'inspection-a', operationId: 'operation-a' };
const inventory = (overrides: Record<string, string> = {}) => {
  const values = { family: 'linux', distribution: 'debian', os_version: '12', kernel: '6.12.1', architecture: 'arm64',
    identity: 'a'.repeat(64), cpu: '0.5', memory_total: '402653184', memory_available: '134217728',
    disk_total: '1000000000', disk_available: '500000000', privilege: 'root', kubernetes: 'unknown',
    kubeadm: 'installed', 'kubeadm-version': 'v1.36.1', kubelet: 'installed', 'kubelet-version': 'v1.36.1',
    kubectl: 'installed', 'kubectl-version': 'v1.36.1', containerd: 'installed', 'containerd-version': 'v2.2.1', ...overrides };
  return 'footprint-host-inventory-v1\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
};
const readAction: HostAction = { id: 'owned-read', effect: 'read-only', script: 'printf safe' };

test('local adapter runs a real bounded registered action with no ambient credentials or script argv', async () => {
  const secret = 'do-not-inherit-the-application-secret';
  process.env.FOOTPRINT_PLATFORM_TEST_SECRET = secret;
  try {
    const transport = new LocalHostAccessTransport({ host, actions: [{ id: 'environment', effect: 'read-only', script: 'printf "%s" "$' + '{FOOTPRINT_PLATFORM_TEST_SECRET-unset}"' }] });
    assert.equal((await transport.run('environment', context)).stdout, 'unset');
    assert.equal(JSON.stringify(transport.actions()).includes(secret), false);
    assert.equal(JSON.stringify(transport.actions()).includes('printf'), false);
  } finally { delete process.env.FOOTPRINT_PLATFORM_TEST_SECRET; }
});

test('action registration snapshots scripts and refuses unknown or unauthorized mutation before executing', async () => {
  let calls = 0;
  const action: HostAction = { ...readAction };
  const transport = new LocalHostAccessTransport({ host, actions: [action, { id: 'change', effect: 'mutating', script: 'printf changed' }], runner: async request => { calls++; assert.equal(request.input, readAction.script); return { stdout: 'safe', code: 0 }; } });
  action.script = 'printf mutated';
  assert.equal(transport.actions()[0]?.digest, hostActionDigest(readAction));
  await transport.run('owned-read', context);
  await assert.rejects(transport.run('unregistered', context), /host-action-not-admitted/);
  await assert.rejects(transport.run('change', context), /host-action-not-admitted/);
  assert.equal(calls, 1);
});

test('local process limits stop excessive output and a non-terminating owned process', async () => {
  const output = new LocalHostAccessTransport({ host, maxOutputBytes: 1024, actions: [{ id: 'output', effect: 'read-only', script: 'while :; do printf 0123456789; done' }] });
  await assert.rejects(output.run('output', context), /host-access-unavailable/);
  const timeout = new LocalHostAccessTransport({ host, timeoutMs: 100, actions: [{ id: 'timeout', effect: 'read-only', script: 'while :; do :; done' }] });
  await assert.rejects(timeout.run('timeout', context), /host-access-unavailable/);
});

test('mutations require an expected physical identity and compare it in the same process before the action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-negative-'));
  const marker = join(directory, 'must-not-exist');
  try {
    const transport = new LocalHostAccessTransport({ host, allowMutations: true,
      actions: [{ id: 'change', effect: 'mutating', script: `printf changed > '${marker}'` }] });
    await assert.rejects(transport.run('change', context), /host-action-not-admitted/);
    await assert.rejects(transport.run('change', { ...context, expectedIdentityDigest: 'f'.repeat(64) }), /host-operation-uncertain/);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('discovery executes the actual read-only inventory locally without turning missing facts into absence', async () => {
  const transport = new LocalHostAccessTransport({ host, actions: [HOST_INVENTORY_ACTION] });
  const facts = await new FixedHostDiscovery({ transport }).inspect(host, context);
  assert.notEqual(facts.status, 'unavailable');
  assert.ok(facts.cpuCount === null || facts.cpuCount > 0);
  assert.notEqual(facts.kubernetes.status, 'absent');
  assert.equal(readHostFactsSnapshot(facts).digest, facts.digest);
  assert.equal(facts.host.profileId, host.profileId);
});

test('fixed discovery refuses a mutating or substituted inventory action and mismatched host identity before I/O', async () => {
  let calls = 0;
  const transport = { id: 'fixture', host, actions: () => [{ id: HOST_INVENTORY_ACTION.id, digest: HOST_INVENTORY_ACTION_DIGEST, effect: 'mutating' as const }],
    async run() { calls++; return { stdout: inventory() }; } };
  const discovery = new FixedHostDiscovery({ transport });
  assert.equal((await discovery.inspect(host, context)).status, 'unavailable');
  assert.equal((await discovery.inspect({ ...host, profileId: 'other-profile' }, context)).status, 'unavailable');
  assert.equal(calls, 0);
});

test('safe measured snapshots keep quotas and unknowns explicit and admit only exact fields/digests', () => {
  const facts = readHostInventoryOutput(inventory(), host, 100);
  assert.equal(facts.status, 'partial');
  assert.equal(facts.cpuCount, 0.5);
  assert.equal(facts.memory.totalBytes, 384 * 1024 * 1024);
  assert.equal(facts.kubernetes.status, 'unknown');
  assert.equal(facts.tools.kubeadm?.version, 'v1.36.1');
  assert.throws(() => readHostFactsSnapshot({ ...facts, credential: 'private-value' }), /invalid-host-access/);
  assert.throws(() => readHostFactsSnapshot({ ...facts, cpuCount: 64 }), /invalid-host-access/);
  assert.throws(() => readHostFactsSnapshot({ ...facts, identityDigest: { toString() { return 'a'.repeat(64); } } }), /invalid-host-access/);
  let accessed = false;
  assert.throws(() => readHostFactsSnapshot({ get host() { accessed = true; return host; } }), /invalid-host-access/);
  assert.equal(accessed, false);
});

test('malformed inventory and raw private provider errors become safe unavailable facts', async () => {
  const secret = 'private-provider-body';
  for (const output of [inventory() + `secret=${secret}\n`, inventory({ 'kubeadm-version': secret }), secret]) {
    const facts = readHostInventoryOutput(output, host);
    assert.equal(facts.status, 'unavailable'); assert.equal(facts.identityDigest, null);
    assert.equal(JSON.stringify(facts).includes(secret), false);
  }
  const transport = { id: 'bad', host, actions: () => [{ id: HOST_INVENTORY_ACTION.id, digest: HOST_INVENTORY_ACTION_DIGEST, effect: 'read-only' as const }], run: async () => { throw Error(secret); } };
  const facts = await new FixedHostDiscovery({ transport }).inspect(host, context);
  assert.equal(facts.status, 'unavailable'); assert.equal(JSON.stringify(facts).includes(secret), false);
});

async function sshFixture(run: (files: { directory: string; knownHostsFile: string; identityFile: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-ssh-'));
  const knownHostsFile = join(directory, 'known-hosts'), identityFile = join(directory, 'identity');
  await writeFile(knownHostsFile, '[127.0.0.1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZpeHR1cmVrZXk=\n', { mode: 0o600 });
  await writeFile(identityFile, 'never-put-this-private-key-in-argv', { mode: 0o600 });
  try { await run({ directory, knownHostsFile, identityFile }); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('SSH pins literal host trust, uses private temporary key files and streams only the registered script', async () => {
  await sshFixture(async files => {
    let observed: HostProcessRequest | undefined;
    const transport = await createSshHostAccessTransport({ host, hostname: '127.0.0.1', username: 'operator', port: 2222, ...files,
      actions: [readAction], runner: async request => {
        observed = request;
        assert.equal(request.file, '/usr/bin/ssh'); assert.equal(request.input, readAction.script);
        assert.ok(request.args.includes('StrictHostKeyChecking=yes')); assert.ok(request.args.includes('IdentityAgent=none'));
        const at = request.args.indexOf('-i'), key = request.args[at + 1]!;
        assert.notEqual(key, files.identityFile);
        assert.equal((await stat(key)).mode & 0o777, 0o600);
        assert.equal(await readFile(key, 'utf8'), 'never-put-this-private-key-in-argv');
        return { stdout: 'safe', code: 0 };
      } });
    assert.equal((await transport.run('owned-read', context)).stdout, 'safe');
    assert.equal(JSON.stringify(observed?.args).includes('private-key'), false);
    const keyPath = observed!.args[observed!.args.indexOf('-i') + 1]!;
    await assert.rejects(stat(keyPath), { code: 'ENOENT' });
  });
});

test('SSH rejects changed trust and insecure key files before opening the remote process', async () => {
  await sshFixture(async files => {
    let calls = 0;
    const options = { host, hostname: '127.0.0.1', username: 'operator', port: 2222, ...files,
      actions: [readAction], runner: async () => { calls++; return { stdout: 'safe', code: 0 }; } };
    const transport = await createSshHostAccessTransport(options);
    await writeFile(files.knownHostsFile, '[127.0.0.1]:2222 ssh-ed25519 AAAAbmV3a2V5\n');
    await assert.rejects(transport.run('owned-read', context), /host-trust-changed/);
    assert.equal(calls, 0);
    await chmod(files.identityFile, 0o644);
    await assert.rejects(createSshHostAccessTransport(options), /invalid-host-access/);
  });
});

test('SSH captures the host and action registry before asynchronous trust-file inspection', async () => {
  await sshFixture(async files => {
    const action: HostAction = { ...readAction };
    const mutableHost = { ...host };
    const pending = createSshHostAccessTransport({ host: mutableHost, hostname: '127.0.0.1', username: 'operator', port: 2222, ...files,
      actions: [action], runner: async request => { assert.equal(request.input, readAction.script); return { stdout: 'safe', code: 0 }; } });
    action.script = 'printf changed'; mutableHost.profileId = 'other-profile';
    const transport = await pending;
    assert.equal(transport.host.profileId, host.profileId);
    assert.equal((await transport.run('owned-read', context)).stdout, 'safe');
  });
});

test('SSH does not accept shell selectors, wildcard trust or private process bodies in errors', async () => {
  await sshFixture(async files => {
    const options = { host, hostname: '127.0.0.1', username: 'operator', port: 2222, ...files, actions: [readAction] };
    await assert.rejects(createSshHostAccessTransport({ ...options, hostname: 'host;printf-secret' }), /invalid-host-access/);
    await writeFile(files.knownHostsFile, '* ssh-ed25519 AAAAbmV3a2V5\n');
    await assert.rejects(createSshHostAccessTransport(options), /invalid-host-access/);
    await writeFile(files.knownHostsFile, '[127.0.0.1]:2222 ssh-ed25519 AAAAbmV3a2V5\n');
    const secret = 'private-stderr-and-authentication-error';
    const transport = await createSshHostAccessTransport({ ...options, runner: async () => { throw Error(secret); } });
    await assert.rejects(transport.run('owned-read', context), error => {
      assert.ok(error instanceof HostAccessError); assert.equal(error.code, 'host-access-unavailable');
      assert.equal(String(error).includes(secret), false); assert.equal('cause' in error, false); return true;
    });
  });
});

test('heterogeneous discovery dispatch binds exact hosts, adapter identities and constructor callbacks', async () => {
  const first = { ...host }, second = { ...host, id: 'server-b', profileId: 'management-b' };
  const calls: string[] = [];
  const a = { id: 'ssh-inventory', async inspect(ref: typeof host) { calls.push('a'); return readHostInventoryOutput(inventory(), ref); } };
  const b = { id: 'agent-inventory', async inspect(ref: typeof host) { calls.push('b'); return readHostInventoryOutput(inventory({ architecture: 'amd64' }), ref); } };
  const registry = new HostDiscoveryRegistry({ id: 'site', registrations: [{ host: first, discovery: a }, { host: second, discovery: b }] });
  const same = new HostDiscoveryRegistry({ id: 'site', registrations: [{ host: second, discovery: b }, { host: first, discovery: a }] });
  assert.equal(registry.id, same.id);
  a.inspect = async () => { throw Error('must-not-run-replacement'); }; first.profileId = 'changed-profile';
  assert.equal((await registry.inspect(host, context)).architecture, 'arm64');
  assert.equal((await registry.inspect(second, context)).architecture, 'amd64');
  assert.deepEqual(calls, ['a', 'b']);
  await assert.rejects(registry.inspect({ ...host, profileId: 'other' }, context), /host-action-not-admitted/);
  await assert.rejects(registry.inspect({ ...host, id: 'unregistered' }, context), /host-action-not-admitted/);
  assert.deepEqual(calls, ['a', 'b']);
  assert.notEqual(new HostDiscoveryRegistry({ id: 'site', registrations: [{ host, discovery: { ...a, id: 'other-adapter' } }] }).id, registry.id);
});

test('discovery registry rejects duplicate registrations, wrong response identities and private provider errors', async () => {
  const port = { id: 'inventory', async inspect(ref: typeof host) { return readHostInventoryOutput(inventory(), ref); } };
  assert.throws(() => new HostDiscoveryRegistry({ registrations: [{ host, discovery: port }, { host, discovery: port }] }), /invalid-host-access/);
  const wrong = new HostDiscoveryRegistry({ registrations: [{ host, discovery: { ...port, async inspect() { return readHostInventoryOutput(inventory(), { ...host, profileId: 'foreign' }); } } }] });
  await assert.rejects(wrong.inspect(host, context), /host-access-unavailable/);
  const secret = 'private-agent-token-body';
  const failed = new HostDiscoveryRegistry({ registrations: [{ host, discovery: { ...port, async inspect() { throw Error(secret); } } }] });
  await assert.rejects(failed.inspect(host, context), error => {
    assert.ok(error instanceof HostAccessError); assert.equal(String(error).includes(secret), false); return true;
  });
});

test('generic discovery facts admit bounded custom tool identities and versions without Kubernetes-specific entries', () => {
  const original = readHostInventoryOutput(inventory(), host);
  const { digest: _digest, ...base } = original;
  const custom = { ...base, tools: { nomad: { status: 'installed' as const, version: '1.10.5' },
    'company.agent': { status: 'installed' as const, version: 'agent-2026.11' }, 'future.runtime': { status: 'unknown' as const } } };
  const admitted = readHostFactsSnapshot({ ...custom, digest: hostFactsDigest(custom) });
  assert.equal(admitted.tools.nomad?.version, '1.10.5');
  assert.equal(admitted.tools['company.agent']?.version, 'agent-2026.11');
  assert.equal(admitted.tools.kubeadm, undefined, 'a missing observation is not fabricated as installed or absent');
  const reject = (tools: unknown) => assert.throws(() => readHostFactsSnapshot({ ...custom, tools, digest: fingerprint({ ...custom, tools }) }), /invalid-host-access/);
  reject({ 'unsafe/tool': { status: 'installed', version: '1' } });
  reject(JSON.parse('{"__proto__":{"status":"installed","version":"1"}}'));
  reject(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`tool-${index}`, { status: 'unknown' }])));
  reject({ nomad: { status: 'absent', version: '1.10.5' } });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fingerprint } from '../src/util.ts';
import type { ProviderContext, Resource } from '../src/types.ts';
import { IdentityFixtureAdapter } from '../integration/identity/docker-adapter.ts';
import { createIdentityGraph } from '../integration/identity/graph.ts';
import type { IdentityContainerSpec } from '../integration/identity/docker-types.ts';
import type { IdentityContainer, IdentityImage } from '../integration/identity/container-observation.ts';
import { assertSealedIdentityFiles, SEALED_IDENTITY_FILES } from '../integration/identity/sealed-files.ts';
import { assertIdentityCluster, identityApiPort, loadIdentityTarget, validateIdentityTarget, type IdentityTarget } from '../integration/identity/target.ts';

let certificate: Buffer, privateKey: Buffer, certificateDirectory: string;
before(async () => {
  certificateDirectory = await mkdtemp(join(tmpdir(), 'identity-fixture-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.local',
    '-keyout', join(certificateDirectory, 'key.pem'), '-out', join(certificateDirectory, 'cert.pem')], { stdio: 'ignore' });
  certificate = await readFile(join(certificateDirectory, 'cert.pem')); privateKey = await readFile(join(certificateDirectory, 'key.pem'));
});
after(async () => { if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true }); });
const secret = 'private_bind_password_' + 'a'.repeat(32);
const context: ProviderContext = { stack: 'fixture-test', operationId: 'test-operation' };

function config(contextName: string) {
  return { 'current-context': contextName, contexts: [{ name: contextName, context: { cluster: contextName, user: contextName } }],
    clusters: [{ name: contextName, cluster: { server: 'https://127.0.0.1:43101', 'certificate-authority-data': 'private-ca' } }],
    users: [{ name: contextName, user: { 'client-certificate-data': 'private-certificate', 'client-key-data': 'private-key' } }] };
}
function cluster(contextName: string) {
  const name = contextName.slice(5);
  return [{ Name: '/' + name + '-control-plane', State: { Running: true }, HostConfig: { NetworkMode: 'kind' },
    Config: { Labels: { 'io.x-k8s.kind.cluster': name, 'io.x-k8s.kind.role': 'control-plane' } },
    NetworkSettings: { Ports: { '6443/tcp': [{ HostIp: '127.0.0.1', HostPort: '43101' }] } } }];
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const temporary = await mkdtemp(join(tmpdir(), 'identity-fixture-test-')), core = await realpath(temporary);
  t.after(() => rm(core, { recursive: true, force: true }));
  const root = join(core, '.artifacts/identity'), directory = join(root, '1234abcd');
  await mkdir(join(directory, 'ldap'), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, 'provider'), { mode: 0o700 });
  const bytes = new Map<string, Buffer>([
    ['ldap/slapd.conf', Buffer.from('private-local-directory-config')], ['ldap/seed.ldif', Buffer.from('private-local-users')],
    ['provider/neo-realm.json', Buffer.from('{"realm":"neo"}')], ['provider/ldap.crt', certificate],
    ['provider.env', Buffer.from('LDAP_BIND_PASSWORD=' + secret + '\n')], ['ldap/ldap.crt', certificate], ['ldap/ldap.key', privateKey],
  ]);
  for (const [name, content] of bytes) await writeFile(join(directory, name), content, { mode: 0o600 });
  const hash = createHash('sha256'); for (const name of SEALED_IDENTITY_FILES) hash.update(bytes.get(name)!);
  const target: IdentityTarget = { version: 1, id: '1234abcd', directory,
    context: 'kind-footprint-iac-recording-8765dcba', kubeconfig: join(core, '.artifacts/neo/fresh/8765dcba/kubeconfig'),
    namespace: 'footprint-iac-identity-1234abcd', stateDirectory: join(directory, 'state'),
    neoPort: 44001, providerPort: 44002, ldapPort: 44003, issuer: 'http://127.0.0.1:44002/realms/neo',
    providerName: 'footprint-identity-1234abcd-provider', directoryName: 'footprint-identity-1234abcd-directory',
    fixtureDigest: hash.digest('hex'), images: { nodeImage: 'footprint-iac/neo-node:identity-' + '1'.repeat(64),
      pythonImage: 'footprint-iac/neo-python:review-' + '2'.repeat(64), ldapImage: 'sha256:' + '3'.repeat(64), providerImage: 'sha256:' + '4'.repeat(64) } };
  await mkdir(resolve(target.kubeconfig, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target.kubeconfig, JSON.stringify(config(target.context)), { mode: 0o600 });
  await writeFile(resolve(target.kubeconfig, '../prepared.json'), JSON.stringify({ version: 1, stage: 'prepared', context: target.context,
    clusterName: target.context.slice(5), kubeconfig: target.kubeconfig }), { mode: 0o600 });
  await writeFile(join(directory, 'target.json'), JSON.stringify(target), { mode: 0o600 });
  return { root, directory, target, bytes };
}
function observed(target: IdentityTarget, inputContext = context) {
  const resource = createIdentityGraph(target).resources.find(resource => resource.id === 'identity-provider')!;
  const spec = resource.spec as unknown as IdentityContainerSpec;
  const image: IdentityImage = { Id: spec.image, Config: { Env: ['PATH=/usr/bin', 'LANG=C.UTF-8'], Entrypoint: ['/keycloak'], User: '1000', WorkingDir: '/' } };
  const container: IdentityContainer = { Id: 'a'.repeat(64), Image: spec.image, Name: '/' + spec.name, Path: '/keycloak', Args: [...spec.command],
    Config: { ...structuredClone(image.Config), Image: spec.image, Hostname: spec.name,
      Env: [...image.Config.Env!, 'LDAP_BIND_PASSWORD=' + secret, ...spec.environment], Cmd: [...spec.command], Labels: {
        'footprint-iac.identity-owner': fingerprint({ stack: inputContext.stack, id: resource.id, target: target.id }),
        'footprint-iac.identity-spec': JSON.stringify(spec) } }, State: { Running: false },
    HostConfig: { NetworkMode: 'kind', Privileged: false, PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(spec.port) }] } },
    Mounts: spec.mounts.map(mount => ({ Type: 'bind', Source: mount.source, Destination: mount.target, RW: false })),
    NetworkSettings: { Networks: { kind: { NetworkID: 'test-network' } }, Ports: {} } };
  const stopped: Resource = { ...resource, spec: { ...resource.spec, enabled: false } };
  return { resource, stopped, image, container };
}

test('sealed fixture inputs reject changed bytes, redirected files and a mismatched duplicate certificate without exposing secrets', async t => {
  const input = await fixture(t);
  await assertSealedIdentityFiles(input.directory, input.target.fixtureDigest);
  await writeFile(join(input.directory, 'provider.env'), 'LDAP_BIND_PASSWORD=' + secret + '-changed\n');
  await assert.rejects(assertSealedIdentityFiles(input.directory, input.target.fixtureDigest), error => error instanceof Error && !error.message.includes(secret));
  await writeFile(join(input.directory, 'provider.env'), input.bytes.get('provider.env')!);
  await writeFile(join(input.directory, 'ldap/ldap.crt'), 'mismatched-certificate');
  await assert.rejects(assertSealedIdentityFiles(input.directory, input.target.fixtureDigest), /sealed validation/);
  await writeFile(join(input.directory, 'ldap/ldap.crt'), certificate);
  const path = join(input.directory, 'provider/neo-realm.json');
  await rm(path); await symlink(join(input.directory, 'ldap/seed.ldif'), path);
  await assert.rejects(assertSealedIdentityFiles(input.directory, input.target.fixtureDigest), /sealed validation/);
});

test('identity target declarations pin inventory, prepared credentials, names, ports and immutable images', async t => {
  const { target, root } = await fixture(t);
  assert.deepEqual(validateIdentityTarget(target, root), target);
  for (const change of [
    { stateDirectory: '/other/inventory' }, { directory: root }, { kubeconfig: '/other/kubeconfig' },
    { namespace: 'default' }, { providerName: 'unrelated-container' }, { ldapPort: target.providerPort },
    { context: 'kind-footprint-iac-identity-1234abcd' }, { providerAddress: '8.8.8.8' },
    { images: { ...target.images, nodeImage: 'neo:latest' } }, { images: { ...target.images, ldapImage: 'ldap:latest' } },
  ]) assert.throws(() => validateIdentityTarget({ ...target, ...change }, root), /Invalid prepared identity target/);
  const credentials = config(target.context);
  assert.equal(identityApiPort(credentials, target.context), '43101');
  assert.throws(() => identityApiPort({ ...credentials, users: [{ ...credentials.users[0], user: { exec: { command: 'must-not-run' } } }] }, target.context), /private single-context/);
  const outside = config(target.context); outside.clusters[0]!.cluster.server = 'https://production.example:6443';
  assert.throws(() => identityApiPort(outside, target.context), /private single-context/);
  assert.doesNotThrow(() => assertIdentityCluster(cluster(target.context), target.context, '43101'));
  const foreign = cluster(target.context); foreign[0]!.Config.Labels['io.x-k8s.kind.cluster'] = 'another-cluster';
  assert.throws(() => assertIdentityCluster(foreign, target.context, '43101'), /ownership/);
  assert.throws(() => assertIdentityCluster(cluster(target.context), target.context, '43102'), /ownership/);
});

test('target admission inspects only its prepared kind node and refuses symlinked inventory or executable credentials first', async t => {
  const { target, root, directory } = await fixture(t), calls: string[][] = [];
  const runner = async (program: string, args: string[]) => {
    assert.equal(program, 'docker'); calls.push(args);
    assert.deepEqual(args, ['inspect', target.context.slice(5) + '-control-plane']); return JSON.stringify(cluster(target.context));
  };
  assert.deepEqual(await loadIdentityTarget(join(directory, 'target.json'), { root, runner }), target);
  assert.equal(calls.length, 1);
  const dangerous = config(target.context); Object.assign(dangerous.users[0]!.user, { exec: { command: 'must-not-run' } });
  await writeFile(target.kubeconfig, JSON.stringify(dangerous));
  await assert.rejects(loadIdentityTarget(join(directory, 'target.json'), { root, runner }), /admission failed/);
  assert.equal(calls.length, 1, 'unsafe credentials must fail before any process runs');
  await writeFile(target.kubeconfig, JSON.stringify(config(target.context)));
  await symlink(join(directory, 'missing-state'), target.stateDirectory);
  await assert.rejects(loadIdentityTarget(join(directory, 'target.json'), { root, runner }), /admission failed/);
  assert.equal(calls.length, 1);
});

test('owned container admission verifies actual secret environment, readonly mounts, network, ports and command before effects', async t => {
  const { target, root } = await fixture(t), baseline = observed(target);
  const variants: ((value: IdentityContainer) => void)[] = [
    value => { value.Config.Labels['footprint-iac.identity-owner'] = 'foreign-owner'; },
    value => { value.Config.Env![2] = 'LDAP_BIND_PASSWORD=wrong-secret'; },
    value => { value.Mounts[0]!.RW = true; }, value => { value.Mounts[0]!.Source = '/foreign/realm.json'; },
    value => { value.NetworkSettings.Networks.other = {}; }, value => { value.HostConfig.NetworkMode = 'host'; },
    value => { value.HostConfig.PortBindings['8080/tcp']![0]!.HostIp = '0.0.0.0'; },
    value => { value.Config.Cmd = ['unexpected-command']; }, value => { value.Args = ['unexpected-command']; },
    value => { value.Image = 'sha256:' + '9'.repeat(64); }, value => { value.HostConfig.Privileged = true; },
    value => { value.HostConfig.PublishAllPorts = true; },
  ];
  for (const mutate of variants) {
    const container = structuredClone(baseline.container); mutate(container); let effects = 0;
    const adapter = new IdentityFixtureAdapter(target.id, async (_program, args) => {
      if (args[0] === 'ps') return container.Id;
      if (args[0] === 'inspect') return JSON.stringify([container]);
      if (args[0] === 'image') return JSON.stringify([baseline.image]);
      effects++; return '';
    }, root);
    await assert.rejects(adapter.apply(baseline.stopped, context), error => error instanceof Error && !error.message.includes(secret));
    assert.equal(effects, 0);
  }
  const calls: string[][] = [];
  const valid = new IdentityFixtureAdapter(target.id, async (_program, args) => {
    calls.push(args);
    return args[0] === 'ps' ? baseline.container.Id : args[0] === 'inspect' ? JSON.stringify([baseline.container]) : args[0] === 'image' ? JSON.stringify([baseline.image]) : '';
  }, root);
  const admitted = await valid.observe(baseline.stopped, context);
  assert.equal(admitted.owned, true); assert.equal(admitted.ready, true);
  await valid.apply(baseline.resource, context);
  assert.ok(calls.some(args => args[0] === 'start' && args[1] === baseline.container.Id));
});

test('sealed input or mount/health declaration tampering prevents container inspection and creation', async t => {
  const { target, root, directory } = await fixture(t), baseline = observed(target); let calls = 0;
  const adapter = new IdentityFixtureAdapter(target.id, async () => { calls++; return ''; }, root);
  const arbitrary = structuredClone(baseline.resource);
  (arbitrary.spec.mounts as { source: string; target: string }[])[0]!.source = '/private';
  await assert.rejects(adapter.apply(arbitrary, context), /Unsupported local identity fixture/);
  assert.equal(calls, 0);
  const outside = structuredClone(baseline.resource); (outside.spec.health as { url: string }).url = 'http://remote.invalid/';
  await assert.rejects(adapter.apply(outside, context), /Unsupported local identity fixture/);
  assert.equal(calls, 0);
  await writeFile(join(directory, 'ldap/seed.ldif'), 'modified-directory-users');
  await assert.rejects(adapter.apply(baseline.resource, context), /sealed validation/);
  assert.equal(calls, 0);
});

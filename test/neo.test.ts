import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNeoStack, NEO_NAMESPACE } from '../integration/neo/stack.ts';
import { prepareNeo } from '../integration/neo/prepare.mjs';
import { smoke } from '../integration/neo/smoke.mjs';
import { verifyCanonicalMetadata } from '../integration/neo/check-package.mjs';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('Neo trial contains only scoped, credential-free local workloads', () => {
  const stack = createNeoStack();
  const namespace = stack.resources.filter(resource => resource.spec.kind === 'Namespace');
  assert.equal(namespace.length, 1);
  assert.equal(object(namespace[0]!.spec.metadata).name, NEO_NAMESPACE);
  for (const resource of stack.resources) {
    assert.equal(resource.provider, 'kubernetes');
    if (resource.spec.kind !== 'Namespace') assert.equal(object(resource.spec.metadata).namespace, NEO_NAMESPACE);
    assert.ok(!['Secret', 'PersistentVolume', 'ClusterRole', 'ClusterRoleBinding'].includes(String(resource.spec.kind)));
  }
  const deployment = stack.resources.find(resource => resource.spec.kind === 'Deployment')!;
  const pod = object(object(object(deployment.spec.spec).template).spec);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(object(pod.securityContext).runAsNonRoot, true);
  assert.ok(Array.isArray(pod.containers));
  for (const entry of pod.containers) {
    const container = object(entry);
    assert.equal(container.imagePullPolicy, 'Never');
    assert.match(String(container.image), /^footprint-iac\/neo-(node|python):local$/);
    assert.ok(container.readinessProbe);
    for (const entry of (container.env ?? []) as unknown[]) {
      const environment = object(entry);
      assert.equal(environment.valueFrom, undefined, 'The fixture must not inherit Kubernetes secrets.');
      assert.ok(!/TOKEN|PASSWORD|API_KEY|OPENAI|INFLUXDB/.test(String(environment.name)));
    }
  }
  const service = stack.resources.find(resource => resource.spec.kind === 'Service')!;
  assert.equal(object(service.spec.spec).type, 'ClusterIP');
});

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'footprint-iac-neo-snapshot-'));
  const source = join(temporary, 'source');
  const artifactsDirectory = join(temporary, 'artifacts');
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'seo-agentfootprint' }));
  writeFileSync(join(source, 'app.ts'), 'export const fixture = true;\n');
  git('add', 'package.json', 'app.ts');
  const commit = () => git('-c', 'user.name=Local fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
  commit();
  return { source, artifactsDirectory, git, commit, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}

test('Neo snapshot excludes untracked secrets, dependencies and artifacts without modifying source', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, '.env'), 'DUMMY_SECRET=not-a-real-secret\n');
    mkdirSync(join(f.source, 'node_modules'));
    writeFileSync(join(f.source, 'node_modules', 'dummy'), 'not source');
    mkdirSync(join(f.source, '.artifacts'));
    writeFileSync(join(f.source, '.artifacts', 'private.json'), '{"fixture":true}');
    const before = f.git('status', '--porcelain');
    const snapshot = prepareNeo(f.source, { artifactsDirectory: f.artifactsDirectory });
    assert.equal(snapshot.commit, f.git('rev-parse', 'HEAD'));
    assert.equal(readFileSync(join(snapshot.context, 'app.ts'), 'utf8'), 'export const fixture = true;\n');
    for (const path of ['.env', 'node_modules', '.artifacts', '.git']) assert.equal(existsSync(join(snapshot.context, path)), false);
    for (const path of ['Node.Dockerfile', 'Python.Dockerfile', 'start-sidecar.py']) assert.ok(existsSync(join(snapshot.context, '.iac', path)));
    assert.equal(f.git('status', '--porcelain'), before);
    assert.equal(readFileSync(join(f.source, '.env'), 'utf8'), 'DUMMY_SECRET=not-a-real-secret\n');
  } finally { f.cleanup(); }
});

test('Neo snapshot refuses tracked edits before producing any build context', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, 'app.ts'), 'edited\n');
    assert.throws(() => prepareNeo(f.source, { artifactsDirectory: f.artifactsDirectory }), /tracked edits/);
    assert.equal(existsSync(f.artifactsDirectory), false);
  } finally { f.cleanup(); }
});

test('Neo snapshot refuses a committed credential file instead of archiving it', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, '.env'), 'DUMMY_SECRET=not-a-real-secret\n');
    f.git('add', '.env');
    f.commit();
    assert.throws(() => prepareNeo(f.source, { artifactsDirectory: f.artifactsDirectory }), /Tracked credential/);
    assert.equal(existsSync(f.artifactsDirectory), false);
  } finally { f.cleanup(); }
});

test('Neo smoke refuses healthy endpoints when the tool result lacks local provenance', async t => {
  let queried = false;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const path = new URL(String(input)).pathname;
    if (path === '/') return new Response('<html><body>fixture</body></html>', { headers: { 'Content-Type': 'text/html' } });
    if (path === '/tools/mds_get_switch_inventory') {
      queried = true;
      assert.equal(options?.method, 'POST');
      assert.deepEqual(JSON.parse(String(options?.body)), { switch_name: 'SHCSANPLVSW901' });
      return Response.json({ inventory: [{ switch: 'SHCSANPLVSW901' }] });
    }
    return Response.json({ status: 'ok' });
  });
  await assert.rejects(smoke(), /LOCAL SEED/);
  assert.equal(queried, true);
});

test('Neo smoke refuses a stamped result that failed to filter the requested switch', async t => {
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    if (path === '/') return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    if (path === '/tools/mds_get_switch_inventory') return Response.json({
      af_provenance: { source: 'LOCAL SEED' },
      inventory: [{ switch: 'SHCSANPLVSW901' }, { switch: 'SHCSANPLVSW902' }],
    });
    return Response.json({ status: 'ok' });
  });
  await assert.rejects(smoke(), /apply its switch filter/);
});

test('Neo packaging rejects absent or drifted Python metadata instead of a stale fallback', () => {
  const actualPackage = Buffer.from(JSON.stringify({ notes: { ABSENCE_NOTE: 'published note' }, wire: { PERIOD_WIRE: { key: 'period' } } }));
  assert.equal(verifyCanonicalMetadata(actualPackage, Buffer.from(actualPackage)).bytes, actualPackage.length);
  assert.throws(() => verifyCanonicalMetadata(actualPackage, Buffer.alloc(0)), /must contain the published package metadata/);
  const staleCopy = Buffer.from(JSON.stringify({ notes: { ABSENCE_NOTE: 'old copied note' }, wire: { PERIOD_WIRE: { key: 'period' } } }));
  assert.throws(() => verifyCanonicalMetadata(actualPackage, staleCopy), /differs from the actual Node package/);
});

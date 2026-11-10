import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { proveIdentityAcceptance } from '../integration/identity/proof.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import { InfraEngine, FileStateStore, SimulatorAdapter } from '../src/index.ts';
import { authorizeAccess, checkIdentityAccess, type IdentityCheckRequest } from '../src/identity/index.ts';

const phases = ['baseline', 'outage', 'recovery'] as const;
type Phase = typeof phases[number];
type LensDirectory = 'lens' | 'lens-live-app';
interface Snapshot {
  run: { id: string; status: string; report: { evidencePath: string; tracePath: string } };
  identity: { id: string; status: string; report: { evidencePath: string; tracePath: string } };
}
const canaries = { first: 'test-only-private-canary-' + 'a'.repeat(24), second: 'test-only-private-canary-' + 'b'.repeat(24),
  third: 'test-only-private-canary-' + 'c'.repeat(24) };

/** Real native charts and JSONL streams, entirely offline; capture metadata represents a cached local receipt. */
async function fixture(t: { after(fn: () => Promise<void>): void }, lensDirectory: LensDirectory) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'iac-identity-proof-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target: IdentityTarget = { version: 1, id: '1234abcd', directory, context: 'kind-footprint-iac-recording-8765dcba',
    kubeconfig: join(directory, 'kubeconfig'), namespace: 'footprint-iac-identity-1234abcd', stateDirectory: join(directory, 'state'),
    neoPort: 44001, providerPort: 44002, ldapPort: 44003, issuer: 'http://127.0.0.1:44002/realms/neo',
    providerName: 'footprint-identity-1234abcd-provider', directoryName: 'footprint-identity-1234abcd-directory',
    fixtureDigest: '0'.repeat(64), images: { nodeImage: 'test-node', pythonImage: 'test-python', ldapImage: 'test-ldap', providerImage: 'test-provider' } };
  const engine = new InfraEngine({ adapters: [new SimulatorAdapter()], store: new FileStateStore(target.stateDirectory),
    traceDirectory: join(directory, 'deployment-traces') });
  const deployment = await engine.apply({ name: 'identity-proof', resources: [{ id: 'app', provider: 'simulator', dependsOn: [], spec: {} }] });
  assert.equal(deployment.ok, true); assert.ok(deployment.tracePath);
  const checks: readonly IdentityCheckRequest[] = [
    { id: 'guest-denied', label: 'Guest refused', kind: 'access', expected: 'denied' },
    { id: 'directory-available', label: 'Directory available', kind: 'directory', expected: 'available' },
  ];
  const snapshots = {} as Record<Phase, Snapshot>;
  const identityDirectory = join(directory, lensDirectory, 'identity'); await mkdir(identityDirectory, { recursive: true });
  for (const phase of phases) {
    const result = await checkIdentityAccess({ stack: 'identity-proof', checks, traceDirectory: join(directory, lensDirectory, 'identity-traces'),
      adapter: { async check(request) { return { verdict: phase === 'outage' ? 'unavailable' : request.expected, observedAt: Date.now(), latencyMs: 1 }; } } });
    assert.ok(result.tracePath);
    const evidencePath = join(identityDirectory, result.runId + '.json'); await writeFile(evidencePath, JSON.stringify(result));
    snapshots[phase] = { run: { id: deployment.runId, status: 'passed', report: { evidencePath: deployment.evidencePath, tracePath: deployment.tracePath } },
      identity: { id: result.runId, status: result.ok ? 'passed' : 'failed', report: { evidencePath, tracePath: result.tracePath } } };
  }
  const podUid = randomUUID(), applicationDirectory = join(directory, 'app-policy', podUid);
  await mkdir(applicationDirectory, { recursive: true });
  for (const groups of [['readers'], []]) {
    const result = await authorizeAccess({ policy: { id: 'read-policy', rules: [{ id: 'readers', effect: 'allow', source: 'directory', groups: ['readers'],
      actions: ['read'], resources: ['app'] }] }, subject: { id: 'test-user', source: 'directory', groups }, action: 'read', resource: 'app',
    traceDirectory: join(applicationDirectory, 'traces') });
    await writeFile(join(applicationDirectory, result.runId + '.json'), JSON.stringify(result));
  }
  await writeFile(join(applicationDirectory, 'capture.json'), JSON.stringify({ version: 1, targetId: target.id, context: target.context,
    namespace: target.namespace, deploymentUid: randomUUID(), pod: 'cached-fixture-pod', podUid, directory: applicationDirectory,
    files: 4, bytes: 0, capturedAt: new Date().toISOString(), loopback: { localhostStatus: 200, podIpReachable: false } }));
  await writeFile(join(directory, 'credentials.json'), JSON.stringify(canaries));
  async function save(values = snapshots) {
    for (const phase of phases) await writeFile(join(directory, 'lens-' + phase + '.json'), JSON.stringify(values[phase]));
  }
  await save();
  return { target, snapshots, save };
}

for (const directory of ['lens', 'lens-live-app'] as const) {
  test('offline acceptance replays three native identity phases from the exact owned ' + directory + ' directory', async t => {
    const { target, snapshots } = await fixture(t, directory);
    const result = await proveIdentityAcceptance(target);
    assert.equal(result.originalDeploymentRunId, snapshots.baseline.run.id);
    assert.deepEqual(result.identityRuns.map(run => [run.phase, run.status, run.runId]),
      phases.map(phase => [phase, phase === 'outage' ? 'failed' : 'passed', snapshots[phase].identity.id]));
    assert.equal(result.allowed, 1); assert.equal(result.denied, 1);
    assert.ok(result.credentialScan.scope.includes('lens-live-app/identity'));
    assert.ok(result.credentialScan.scope.includes('lens-live-app/identity-traces'));
    for (const phase of phases) assert.match(await readFile(snapshots[phase].identity.report.evidencePath.replace(/\.json$/, '.progress-guest-denied.backwalk.txt'), 'utf8'), /observation:guest-denied/);
  });
}

test('offline acceptance refuses mixed Lens directories, split evidence/trace roots, aliases and changed deployment runs', async t => {
  const { target, snapshots, save } = await fixture(t, 'lens-live-app');
  for (const kind of ['identity', 'identity-traces']) await mkdir(join(target.directory, 'lens', kind), { recursive: true });
  for (const phase of phases) {
    const identity = snapshots[phase].identity;
    await writeFile(join(target.directory, 'lens/identity', identity.id + '.json'), await readFile(identity.report.evidencePath));
    await writeFile(join(target.directory, 'lens/identity-traces', identity.id + '.jsonl'), await readFile(identity.report.tracePath));
  }
  for (const mutate of [
    (values: Record<Phase, Snapshot>) => { values.outage.identity.report.evidencePath = join(target.directory, 'lens/identity', values.outage.identity.id + '.json');
      values.outage.identity.report.tracePath = join(target.directory, 'lens/identity-traces', values.outage.identity.id + '.jsonl'); },
    (values: Record<Phase, Snapshot>) => { values.recovery.identity.report.tracePath = join(target.directory, 'lens/identity-traces', values.recovery.identity.id + '.jsonl'); },
    (values: Record<Phase, Snapshot>) => { values.baseline.identity.report.evidencePath = join(target.directory, 'lens-live-app-copy/identity', values.baseline.identity.id + '.json'); },
    (values: Record<Phase, Snapshot>) => { values.baseline.identity.report.evidencePath = target.directory + '/lens-live-app/../lens-live-app/identity/' + values.baseline.identity.id + '.json'; },
    (values: Record<Phase, Snapshot>) => { values.outage.run.id = randomUUID(); },
    (values: Record<Phase, Snapshot>) => { values.outage.identity.id = values.baseline.identity.id; },
  ]) {
    const changed = structuredClone(snapshots); mutate(changed); await save(changed);
    await assert.rejects(proveIdentityAcceptance(target));
  }
  await save();
  await proveIdentityAcceptance(target);
});

test('offline acceptance refuses symlinked native identity evidence in an allowed directory', async t => {
  const { target, snapshots } = await fixture(t, 'lens-live-app');
  const path = snapshots.baseline.identity.report.evidencePath, copy = join(target.directory, 'redirected.json');
  await writeFile(copy, await readFile(path)); await rm(path); await symlink(copy, path);
  await assert.rejects(proveIdentityAcceptance(target));
});

test('credential scans include both live Lens evidence roots even when the reviewed phases use legacy Lens', async t => {
  const { target } = await fixture(t, 'lens');
  for (const name of ['identity', 'identity-traces']) {
    const directory = join(target.directory, 'lens-live-app', name); await mkdir(directory, { recursive: true });
    const path = join(directory, 'private-evidence.txt');
    await writeFile(path, canaries.first);
    await assert.rejects(proveIdentityAcceptance(target), /Credential canaries/);
    await writeFile(path, 'eyJ' + 'a'.repeat(16) + '.' + 'b'.repeat(16) + '.' + 'c'.repeat(24));
    await assert.rejects(proveIdentityAcceptance(target), /Complete bearer JWTs/);
    await rm(path);
  }
  const result = await proveIdentityAcceptance(target);
  assert.equal(result.credentialScan.credentialOccurrences, 0); assert.equal(result.credentialScan.jwtLikeOccurrences, 0);
});

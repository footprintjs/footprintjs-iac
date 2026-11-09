import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { ReconcileStrategy } from '../src/strategies.ts';
import { createDeploymentRecorder } from '../src/progress/index.ts';
import { fingerprint } from '../src/util.ts';
import type { Observation, Resource, ResourceAdapter } from '../src/types.ts';

type AfterReadiness = 'drift' | 'ownership' | 'absent' | 'unknown' | 'stable';

/** The create lands and its reply is lost; readiness can race a later provider change. */
class LostReplyProvider implements ResourceAdapter {
  readonly name = 'recovery-fixture';
  readonly scope = 'in-memory-recovery-fixture';
  readonly supportsSafeRetry = true;
  creates = 0;
  removes = 0;
  readinessChecks = 0;
  private current: Observation = { exists: false };
  private readinessEnded = false;
  private readonly afterReadiness: AfterReadiness;

  constructor(afterReadiness: AfterReadiness) { this.afterReadiness = afterReadiness; }
  async observe(): Promise<Observation> {
    if (this.readinessEnded && this.afterReadiness === 'unknown') throw new Error('Final provider observation unavailable');
    return structuredClone(this.current);
  }
  async apply(resource: Resource): Promise<void> {
    this.creates++;
    this.current = { exists: true, owned: true, fingerprint: fingerprint(resource.spec), physicalId: 'fixture://before-ready' };
    throw new Error('Create reply lost after provider effect');
  }
  async waitReady(): Promise<void> {
    this.readinessChecks++;
    this.readinessEnded = true;
    if (this.afterReadiness === 'drift') this.current.fingerprint = 'provider-drifted';
    if (this.afterReadiness === 'ownership') this.current.owned = false;
    if (this.afterReadiness === 'absent') this.current = { exists: false };
    if (this.afterReadiness === 'stable') this.current.physicalId = 'fixture://verified-ready';
  }
  async remove(): Promise<void> {
    this.removes++;
    this.current = { exists: false };
    throw new Error('Delete reply lost after provider effect');
  }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, mode: AfterReadiness) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-recovered-ready-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new LostReplyProvider(mode);
  const recorder = createDeploymentRecorder();
  const store = new FileStateStore(directory);
  const resource: Resource = { id: 'app', provider: provider.name, spec: { image: 'fixture:v1' } };
  const stack = { name: 'recovered-ready', resources: [resource] };
  const engine = new InfraEngine({ adapters: [provider], store, strategy: new ReconcileStrategy(2), recorders: [recorder] });
  return { provider, recorder, store, resource, stack, engine };
}

for (const mode of ['drift', 'ownership', 'absent', 'unknown'] as const) {
  test(`recovered create refuses ${mode} after readiness instead of recording success`, async t => {
    const { provider, recorder, store, resource, stack, engine } = await fixture(t, mode);
    const result = await engine.apply(stack);
    assert.equal(result.ok, false, 'an earlier matching observation cannot prove the post-readiness resource');
    assert.equal(provider.creates, 1, 'an uncertain recovered create is not sent again');
    assert.equal(provider.readinessChecks, 1);
    assert.match(result.failure?.message ?? '', mode === 'unknown' ? /Final provider observation unavailable/ : /Provider did not converge/);
    assert.equal(recorder.getSnapshot().resources.app?.status, 'failed');
    assert.equal(recorder.getSnapshot().events.some(event => event.status === 'ready'), false);
    const saved = (await store.load(stack.name)).resources.app!;
    assert.equal(saved.pending?.action, 'create', 'the unresolved intent stays durable for later reconciliation');
    assert.equal(saved.pending?.desiredFingerprint, fingerprint(resource.spec));
    assert.notEqual(saved.fingerprint, fingerprint(resource.spec), 'unverified desired state must not be checkpointed as complete');
    const journal = await store.readJournal();
    assert.equal(journal.filter(entry => entry.event === 'complete').length, 0);
    assert.equal(journal.filter(entry => entry.event === 'failed').length, 1);
  });
}

test('recovered create checkpoints the final authoritative observation after readiness', async t => {
  const { provider, recorder, store, stack, engine } = await fixture(t, 'stable');
  const result = await engine.apply(stack);
  assert.equal(result.ok, true);
  assert.equal(provider.creates, 1);
  assert.equal(recorder.getSnapshot().resources.app?.status, 'ready');
  const saved = (await store.load(stack.name)).resources.app!;
  assert.equal(saved.pending, undefined);
  assert.equal(saved.physicalId, 'fixture://verified-ready');
});

test('a lost delete reply still recovers from authoritative absence without a readiness check', async t => {
  const { provider, recorder, store, stack, engine } = await fixture(t, 'stable');
  assert.equal((await engine.apply(stack)).ok, true);
  const readinessBeforeDelete = provider.readinessChecks;
  const result = await engine.apply({ ...stack, resources: [] }, { prune: true });
  assert.equal(result.ok, true);
  assert.equal(provider.removes, 1);
  assert.equal(provider.readinessChecks, readinessBeforeDelete);
  assert.deepEqual((await store.load(stack.name)).resources, {});
  assert.equal(recorder.getSnapshot().resources.app?.status, 'deleted');
});

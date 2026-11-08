import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stateAt, sliceForKey, keysReadFromExecutionTree, flattenCausalDAG, readStoredRecord, type CommitBundle, type ControlDependency } from 'foottrace';
import { readRecordFile } from 'footprintjs/sinks';
import type { RuntimeSnapshot } from 'footprintjs';
import { InfraEngine } from '../src/engine.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { FileStateStore } from '../src/store.ts';
import { ReconcileStrategy } from '../src/strategies.ts';
import type { JournalEntry, Resource, ProviderContext, StackState } from '../src/types.ts';

const resource = (id: string, dependsOn: string[] = []): Resource => ({ id, provider: 'simulator', dependsOn, spec: { value: id } });

class DelayedAdapter extends SimulatorAdapter {
  active = 0;
  peak = 0;
  events: string[] = [];
  durations = new Map<string, number>();
  private barrier: { count: number; started: number; ready: Promise<void>; release: () => void } | undefined;
  synchronizeFirst(count: number): void {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    this.barrier = { count, started: 0, ready, release };
  }
  override async apply(item: Resource, context: ProviderContext): Promise<void> {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    this.events.push(`start:${item.id}`);
    try {
      const barrier = this.barrier;
      if (barrier && barrier.started < barrier.count) {
        barrier.started++;
        if (barrier.started === barrier.count) barrier.release();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([barrier.ready, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Independent provider calls never overlapped')), 3000);
          })]);
        } finally { clearTimeout(timer); }
      }
      await delay(this.durations.get(item.id) ?? 15);
      await super.apply(item, context);
    } finally {
      this.active--;
      this.events.push(`finish:${item.id}`);
    }
  }
}

class CheckedStore extends FileStateStore {
  active = 0;
  peak = 0;
  snapshots: string[] = [];
  private async record(work: () => Promise<void>): Promise<void> {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try { await delay(2); await work(); } finally { this.active--; }
  }
  override async save(state: StackState): Promise<void> {
    const before = JSON.stringify(state);
    await this.record(async () => {
      assert.equal(JSON.stringify(state), before, 'queued persistence must receive an immutable snapshot');
      this.snapshots.push(before);
      await super.save(state);
    });
  }
  override async append(entry: JournalEntry): Promise<void> {
    await this.record(() => super.append(entry));
  }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, adapter = new DelayedAdapter(), maxConcurrency = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-concurrency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CheckedStore(join(directory, 'state'));
  const engine = new InfraEngine({ adapters: [adapter], store, maxConcurrency, strategy: new ReconcileStrategy(1) });
  return { directory, adapter, store, engine };
}

test('maxConcurrency accepts only a bounded positive integer', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 129]) {
    assert.throws(() => new InfraEngine({ adapters: [new SimulatorAdapter()], store: new FileStateStore('/tmp/unused-iac-test'), maxConcurrency: value }), /maxConcurrency/);
  }
});

test('native dependency-aware parallel batches respect the limit, settle before dependents and retain every checkpoint', async t => {
  const { adapter, store, engine } = await fixture(t);
  adapter.synchronizeFirst(2);
  const stack = { name: 'parallel', resources: [resource('dependent', ['left', 'right']), resource('left'), resource('right'), resource('another'), resource('last', ['another'])] };
  const result = await engine.apply(stack);
  assert.equal(result.ok, true);
  assert.equal(adapter.peak, 2, 'independent resources must actually overlap');
  assert.equal(adapter.active, 0);
  for (const id of ['left', 'right']) assert.ok(adapter.events.indexOf(`start:dependent`) > adapter.events.indexOf(`finish:${id}`));
  assert.ok(adapter.events.indexOf('start:last') > adapter.events.indexOf('finish:another'));
  assert.equal(store.peak, 1, 'state saves and journal appends must be serialized');
  assert.deepEqual(Object.keys((await store.load(stack.name)).resources).sort(), stack.resources.map(item => item.id).sort());
  const complete = (await store.readJournal()).filter(entry => entry.event === 'complete');
  assert.deepEqual(complete.map(entry => entry.resourceId).sort(), stack.resources.map(item => item.id).sort());
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as { snapshot: RuntimeSnapshot; controlDeps: Record<string, ControlDependency> };
  const runtimeNodes: { logs?: { selectedChildIds?: string[] }; children?: unknown[]; next?: unknown; name?: string }[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const node = value as typeof runtimeNodes[number];
    runtimeNodes.push(node);
    for (const child of node.children ?? []) visit(child);
    visit(node.next);
  }
  visit(evidence.snapshot.executionTree);
  assert.ok(runtimeNodes.some(node => node.logs?.selectedChildIds?.length === 2 && node.children?.length === 2), 'native execution evidence must contain a two-branch selector fan-out');
  assert.deepEqual(stateAt(evidence.snapshot, evidence.snapshot.commitLog.length - 1).state, evidence.snapshot.sharedState);
  const slice = sliceForKey(evidence.snapshot.commitLog, 'result:dependent', keysReadFromExecutionTree(evidence.snapshot.executionTree), { controlDeps: id => evidence.controlDeps[id] });
  assert.ok(slice.root);
  const stages = flattenCausalDAG(slice.root).map(node => node.stageName);
  assert.ok(stages.includes('Reconcile dependent'));
  assert.ok(stages.includes('Reconcile left'));
  assert.ok(stages.includes('Reconcile right'));
});

test('a failed sibling stops later dispatch while already-started siblings finish and stay managed', async t => {
  const adapter = new DelayedAdapter({ faults: { failBeforeApply: new Set(['bad']) } });
  adapter.synchronizeFirst(2);
  adapter.durations.set('bad', 1);
  adapter.durations.set('sibling', 35);
  const { store, engine } = await fixture(t, adapter);
  const stack = { name: 'failure', resources: [resource('bad'), resource('sibling'), resource('queued'), resource('downstream', ['bad'])] };
  const result = await engine.apply(stack);
  assert.equal(result.ok, false);
  assert.equal(result.failure?.resourceId, 'bad');
  assert.equal(adapter.peak, 2);
  assert.equal(adapter.active, 0, 'the engine must await in-flight siblings before returning');
  assert.deepEqual(adapter.calls.map(call => call.id).sort(), ['bad', 'sibling']);
  assert.deepEqual(result.results.queued, { status: 'skipped' });
  assert.deepEqual(result.results.downstream, { status: 'skipped' });
  assert.equal((await adapter.observe(resource('sibling'), { stack: stack.name, operationId: 'inspect' })).exists, true);
  const saved = await store.load(stack.name);
  assert.ok(saved.resources.sibling);
  assert.ok((await store.readJournal()).some(entry => entry.event === 'complete' && entry.resourceId === 'sibling'));
});

test('a new engine continues a partially successful parallel run without replaying completed effects', async t => {
  const adapter = new DelayedAdapter({ faults: { failBeforeApply: new Set(['bad']) } });
  const { store, engine } = await fixture(t, adapter);
  const stack = { name: 'restart', resources: [resource('bad'), resource('good'), resource('child', ['bad', 'good'])] };
  assert.equal((await engine.apply(stack)).ok, false);
  adapter.faults.failBeforeApply!.clear();
  adapter.calls.length = 0;
  const restarted = new InfraEngine({ adapters: [adapter], store: new FileStateStore(store.directory), maxConcurrency: 2 });
  assert.equal((await restarted.apply(stack)).ok, true);
  assert.deepEqual(adapter.calls.map(call => call.id), ['bad', 'child']);
  adapter.calls.length = 0;
  const unchanged = await restarted.apply(stack);
  assert.equal(unchanged.ok, true);
  assert.ok(unchanged.plan.operations.every(operation => operation.action === 'noop'));
  assert.equal(adapter.calls.length, 0);
});

test('parallel failure backwalk reaches the failed resource and desired inputs after the native join', async t => {
  const adapter = new DelayedAdapter({ faults: { failBeforeApply: new Set(['bad']) } });
  const { engine } = await fixture(t, adapter);
  const result = await engine.apply({ name: 'evidence', resources: [resource('bad'), resource('good'), resource('downstream', ['bad'])] });
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as { snapshot: RuntimeSnapshot; controlDeps: Record<string, ControlDependency> };
  const failure = sliceForKey(evidence.snapshot.commitLog, 'failure', keysReadFromExecutionTree(evidence.snapshot.executionTree), { controlDeps: id => evidence.controlDeps[id] });
  assert.ok(failure.root);
  const nodes = flattenCausalDAG(failure.root);
  assert.ok(nodes.some(node => node.stageName === 'Reconcile bad'));
  assert.ok(nodes.some(node => node.stageName === 'Load desired resources'));
  assert.ok(nodes.some(node => node.parentEdges.some(edge => edge.kind === 'control')));
});

test('pruning remains serial and deletes dependents before their dependencies even with parallel apply enabled', async t => {
  const { adapter, engine, store } = await fixture(t, new DelayedAdapter(), 3);
  const stack = { name: 'prune', resources: [resource('network'), resource('app', ['network']), resource('cache', ['network'])] };
  assert.equal((await engine.apply(stack)).ok, true);
  adapter.calls.length = 0;
  const result = await engine.apply({ name: stack.name, resources: [] }, { prune: true });
  assert.equal(result.ok, true);
  assert.deepEqual(adapter.calls.map(call => call.id), ['cache', 'app', 'network']);
  assert.deepEqual((await store.load(stack.name)).resources, {});
});


test('pinned native parallel scope publishes disjoint root commits and JSONL independently replays their provenance', async t => {
  const { directory, adapter, store } = await fixture(t);
  adapter.synchronizeFirst(2);
  const result = await new InfraEngine({ adapters: [adapter], store, maxConcurrency: 2, traceDirectory: join(directory, 'traces') })
    .apply({ name: 'parallel-native-record', resources: [resource('left'), resource('right'), resource('after', ['left', 'right'])] });
  assert.equal(result.ok, true);
  assert.equal(adapter.peak, 2);
  assert.ok(result.tracePath);
  assert.equal(result.traceStatus?.flushed, true);
  const file = readRecordFile(result.tracePath);
  assert.deepEqual(file.unreadable, []);
  const stored = readStoredRecord(file.entries);
  assert.deepEqual(stored.unread, []);
  const root = [...stored.logs.values()].find(log => log.address.drillPath.length === 0);
  assert.ok(root);
  assert.equal(root.complete, true);
  assert.deepEqual(root.gaps, []);
  for (const id of ['left', 'right', 'after']) {
    const writers: CommitBundle[] = root.commitLog.filter(commit => commit.trace.some(row => row.path === `result:${id}`));
    assert.equal(writers.length, 1, `one native writer must own the literal root result key for ${id}`);
    assert.equal(writers[0]!.stage, `Reconcile ${id}`);
    const row = writers[0]!.trace.find(entry => entry.path === `result:${id}`)!;
    assert.ok(row.readKeys?.includes(`desired:${id}`));
  }
  assert.equal(root.commitLog.some(commit => commit.trace.some(row => row.path.startsWith('runs\u001f'))), false,
    'parallel results must not be reattributed to a namespaced container or a promotion stage');
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as { snapshot: RuntimeSnapshot };
  assert.deepEqual(stateAt(root.source(), root.commitLog.length - 1).state, evidence.snapshot.sharedState);
  // Read-prefix provenance comes entirely from stored commits; no final execution tree is needed.
  const slice = sliceForKey([...root.commitLog], 'result:after', () => []);
  assert.ok(slice.root);
  const stages = flattenCausalDAG(slice.root).map(node => node.stageName);
  for (const id of ['left', 'right', 'after']) assert.ok(stages.includes(`Reconcile ${id}`));
});

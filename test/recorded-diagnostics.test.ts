import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { queryRecordedDependencies, readRecordedDependencyResult, type RecordedDependencyInput } from '../src/diagnostics/recorded.ts';
import { loadEvidence, backwalk } from '../src/evidence.ts';
import { explainRun } from '../src/diagnostics/explain.ts';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';

function fixture(ambiguous = false) {
  const state = new SharedMemory(), log = new EventLog({});
  function frame() { const value = new RecordFrame(state, log); value.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' }); return value; }
  function finish(value: RecordFrame, id: string) { value.commit(() => ({ stage: id, stageId: id, runtimeStageId: id + '#0' })); value.release(); }
  const seed = frame(); seed.write(['value'], 1, 'set'); finish(seed, 'seed');
  const reader = frame(), observed = reader.read([], 'value'); reader.noteRead([], 'value');
  const sibling = frame(); sibling.write(['value'], 2, 'set'); sibling.write(['late'], true, 'set'); finish(sibling, 'sibling');
  if (ambiguous) { reader.read([], 'late'); reader.noteRead([], 'late'); }
  reader.write(['result'], observed, 'set'); finish(reader, 'reader');
  const steps = [ { runtimeStageId: 'seed#0' }, { runtimeStageId: 'sibling#0' },
    { runtimeStageId: 'reader#0', stageReads: { value: observed, ...(ambiguous ? { late: true } : {}) } } ];
  return { observed, input: { snapshot: { runId: 'query-contract', commitLog: log.list(), executionTree: steps,
    writeProvenance: 'reads-prefix' }, controlDeps: {} } satisfies RecordedDependencyInput };
}

test('browser diagnostics use recorded per-write sources and retain temporal uncertainty', () => {
  const precise = fixture(), result = queryRecordedDependencies(precise.input, 'result');
  assert.equal(precise.observed, 1); assert.equal(result.status, 'available');
  assert.deepEqual(Object.keys(result.dependencies!.nodes!).sort(), ['reader#0', 'seed#0']);
  assert.deepEqual(result.order, [{ nodeId: 'seed#0', commitIndex: 0 }, { nodeId: 'reader#0', commitIndex: 2 }]);
  assert.equal(result.provenance.requested, 'per-write'); assert.equal(result.provenance.recorded, 'reads-prefix');
  assert.ok(result.provenance.withReadPrefix > 0); assert.equal(result.summary.possibleSourceEdges, 0);
  const uncertain = queryRecordedDependencies(fixture(true).input, 'result');
  assert.equal(uncertain.summary.possibleSourceEdges, 3);
  assert.deepEqual(uncertain.dependencies!.edges!.filter(edge => edge.key === 'value').map(edge => edge.overlap).sort(), ['replaced-while-running', 'written-while-running']);
  assert.ok(uncertain.dependencies!.notes!.some(note => note.code === 'concurrent-write'));
  assert.ok(uncertain.limitations.some(note => note.includes('several possible')));
});

test('linked and chain recording shapes use the same released reads resolver', () => {
  const { input } = fixture(), chain = input.snapshot.executionTree;
  const linked = { ...input, snapshot: { ...input.snapshot,
    executionTree: { ...chain[0], next: { ...chain[1], next: chain[2] } } } };
  assert.deepEqual(queryRecordedDependencies(linked, 'result'), queryRecordedDependencies(input, 'result'));
});

test('legacy and reads-less recordings retain explicit coverage limits', () => {
  const { input } = fixture();
  const commitLog = input.snapshot.commitLog.map(commit => ({ ...commit,
    trace: commit.trace.map(({ readKeys: _readKeys, ...row }) => row) }));
  const old = { snapshot: { ...input.snapshot, commitLog, writeProvenance: 'off' } };
  const result = queryRecordedDependencies(old, 'result');
  assert.equal(result.status, 'available'); assert.equal(result.provenance.recorded, 'off');
  assert.ok(result.provenance.withoutReadPrefix > 0);
  assert.ok(result.limitations.some(note => note.includes('conservatively')));
  assert.ok(result.limitations.some(note => note.includes('Control dependencies were not supplied')));
  const noReads = queryRecordedDependencies({ snapshot: { ...old.snapshot,
    executionTree: input.snapshot.executionTree.map(({ runtimeStageId }) => ({ runtimeStageId })) } }, 'result');
  assert.equal(noReads.coverage?.stepsWithReads, 0);
  assert.ok(noReads.limitations.some(note => note.includes('cannot be distinguished')));
  assert.equal(queryRecordedDependencies(input, 'not-written').status, 'missing');
});

test('queries ignore raw state and retained read values, refuse executable recording fields, and bound answers', () => {
  const { input } = fixture(); let touched = false;
  const snapshot = { ...input.snapshot, get sharedState() { touched = true; throw Error('private raw state'); },
    get initialState() { touched = true; throw Error('private base'); } };
  Object.defineProperty(snapshot.executionTree[2]!.stageReads!, 'value', { enumerable: true, get() { touched = true; throw Error('private read value'); } });
  const result = queryRecordedDependencies({ snapshot, controlDeps: {} }, 'result');
  assert.equal(result.status, 'available'); assert.equal(touched, false);
  const invalid = { ...input, snapshot: { ...input.snapshot, get commitLog(): readonly unknown[] { touched = true; throw Error('private failure'); } } };
  const refused = queryRecordedDependencies(invalid, 'result');
  assert.equal(refused.status, 'unavailable'); assert.equal(refused.error, 'invalid-recording'); assert.equal(touched, false);
  assert.equal(JSON.stringify(refused).includes('private failure'), false);
  assert.equal(queryRecordedDependencies(input, 'result', { maxOutputBytes: 1 }).error, 'query-limit');
  const truncated = queryRecordedDependencies(input, 'result', { maxNodes: 1 });
  assert.equal(truncated.status, 'available'); assert.ok(truncated.dependencies!.truncated);
  assert.ok(truncated.limitations.some(note => note.includes('node or depth limit')));
});

test('actual saved deployment failure shares value-free dependencies across browser and agent readers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'recorded-diagnostics-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = new SimulatorAdapter({ faults: { failBeforeApply: new Set(['bad']) } });
  const engine = new InfraEngine({ adapters: [adapter], store: new FileStateStore(directory) });
  const run = await engine.apply({ name: 'recorded-failure', resources: [
    { id: 'foundation', provider: 'simulator', spec: {} }, { id: 'bad', provider: 'simulator', dependsOn: ['foundation'], spec: {} },
  ] });
  assert.equal(run.ok, false);
  const saved = await loadEvidence(run.evidencePath), before = JSON.stringify(saved);
  const result = queryRecordedDependencies(saved, 'failure');
  assert.equal(result.status, 'available'); assert.ok(result.summary.dataEdges); assert.ok(result.summary.controlEdges);
  assert.ok(Object.values(result.dependencies!.nodes!).some(node => node.stageName === 'Reconcile bad'));
  assert.deepEqual(result.dependencies, explainRun(saved).dependencies);
  assert.equal(backwalk(saved).slice.root?.runtimeStageId, result.dependencies!.writerId);
  assert.equal(JSON.stringify(saved), before, 'read-only analysis cannot change its recording');
  assert.equal(Object.hasOwn(result, 'sharedState'), false);
  assert.equal(Object.hasOwn(result.dependencies!, 'value'), false);
});

test('the public result reader admits only bounded value-free dependency answers', () => {
  const { input } = fixture();
  for (const result of [queryRecordedDependencies(input, 'result'), queryRecordedDependencies(fixture(true).input, 'result'),
    queryRecordedDependencies(input, 'not-written'), queryRecordedDependencies(input, 'result', { maxOutputBytes: 1 })]) {
    const saved = readRecordedDependencyResult(JSON.parse(JSON.stringify(result)));
    assert.deepEqual(saved, result); assert.equal(Object.isFrozen(saved), true);
  }
  const original = queryRecordedDependencies(input, 'result');
  const rawState = { ...original, sharedState: { password: 'must-not-enter-history' } };
  assert.throws(() => readRecordedDependencyResult(rawState), /Invalid recorded dependency result/);
  const payload = structuredClone(original); payload.dependencies!.nodes!['reader#0'] = {
    ...payload.dependencies!.nodes!['reader#0']!, ...{ value: 'must-not-enter-history' },
  };
  assert.throws(() => readRecordedDependencyResult(payload), /Invalid recorded dependency result/);
  const wrongEdge = structuredClone(original); wrongEdge.dependencies!.edges![0]!.to = 'another-run#0';
  assert.throws(() => readRecordedDependencyResult(wrongEdge), /Invalid recorded dependency result/);
  const wrongCount = structuredClone(original); wrongCount.summary.dataEdges++;
  assert.throws(() => readRecordedDependencyResult(wrongCount), /Invalid recorded dependency result/);
  let touched = false;
  assert.throws(() => readRecordedDependencyResult({ ...original, get limitations() { touched = true; throw Error('private'); } }), /Invalid recorded dependency result/);
  assert.equal(touched, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeSnapshot } from 'footprintjs';
import { EventLog, RecordFrame, SharedMemory } from 'foottrace/write';
import { sliceToJSON } from 'foottrace';
import { backwalk, replay, type RunEvidence } from '../src/evidence.ts';
import { explainRun } from '../src/diagnostics/explain.ts';

// The dependency's public writer produces these records; the IaC public readers consume them.
// This protects the attribution fixes that justify our FootTrace version pin.
function frame(state: SharedMemory, log: EventLog) {
  const value = new RecordFrame(state, log);
  value.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
  return value;
}
function finish(value: RecordFrame, id: string) {
  value.commit(() => ({ stage: id, stageId: id, runtimeStageId: id + '#0' })); value.release();
}
function step(id: string, stageReads: Record<string, unknown> = {}, next?: RuntimeSnapshot['executionTree']): RuntimeSnapshot['executionTree'] {
  return { id, runtimeStageId: id + '#0', stageReads, logs: {}, errors: {}, metrics: {}, evals: {}, ...(next ? { next } : {}) };
}
function evidence(state: SharedMemory, log: EventLog, executionTree: RuntimeSnapshot['executionTree']): RunEvidence {
  return { version: 1, runId: 'causal-contract', stack: 'causal-contract', controlDeps: {}, decisions: [], narrative: [],
    snapshot: { runId: 'causal-contract', sharedState: state.getState(), initialState: {}, commitLog: log.list(),
      executionTree, commitValues: 'full', writeProvenance: 'reads-prefix' } };
}

test('IaC backwalk dates a parallel read before the sibling that committed ahead of it', () => {
  const state = new SharedMemory(), log = new EventLog({});
  const seed = frame(state, log); seed.write(['value'], 1, 'set'); finish(seed, 'seed');
  const reader = frame(state, log), observed = reader.read([], 'value'); reader.noteRead([], 'value');
  const sibling = frame(state, log); sibling.write(['value'], 2, 'set'); finish(sibling, 'sibling');
  reader.write(['result'], observed, 'set'); finish(reader, 'reader');

  const record = evidence(state, log, step('seed', {}, step('sibling', {}, step('reader', { value: observed }))));
  assert.equal(observed, 1); assert.equal(state.getState().value, 2); assert.equal(state.getState().result, 1);
  assert.deepEqual(replay(record).state, state.getState());
  const walked = backwalk(record, 'result'), root = walked.slice.root; assert.ok(root);
  assert.deepEqual(root.parentEdges.filter(edge => edge.key === 'value').map(edge => edge.parent.runtimeStageId), ['seed#0']);
  assert.equal(root.parentEdges.some(edge => edge.parent.runtimeStageId === 'sibling#0'), false);
  const explained = explainRun(record, 'result');
  assert.deepEqual(Object.keys(explained.dependencies.nodes!).sort(), ['reader#0', 'seed#0']);
  assert.equal(explained.externalRootCause, 'not-established');
});

test('IaC explanation keeps the seed beneath a merge that did not read the original value', () => {
  const state = new SharedMemory(), log = new EventLog({});
  const seed = frame(state, log); seed.write(['config'], { first: 1 }, 'set'); finish(seed, 'seed');
  const merge = frame(state, log); merge.write(['config'], { second: 2 }, 'merge'); finish(merge, 'merge');
  const reader = frame(state, log), observed = reader.read([], 'config'); reader.noteRead([], 'config');
  reader.write(['result'], observed, 'set'); finish(reader, 'reader');

  const record = evidence(state, log, step('seed', {}, step('merge', {}, step('reader', { config: observed }))));
  assert.deepEqual(observed, { first: 1, second: 2 });
  assert.deepEqual(replay(record).state, state.getState());
  const explained = explainRun(record, 'result');
  assert.deepEqual(Object.keys(explained.dependencies.nodes!).sort(), ['merge#0', 'reader#0', 'seed#0']);
  const composed = explained.dependencies.edges!.find(edge => edge.from === 'merge#0' && edge.to === 'seed#0');
  assert.equal(composed?.key, 'config'); assert.equal(composed?.builtOn, 'partial-write');
  assert.equal(explained.externalRootCause, 'not-established');
});

test('IaC backwalk preserves possible sources when the recorded read window cannot choose one', () => {
  const state = new SharedMemory(), log = new EventLog({});
  const seed = frame(state, log); seed.write(['value'], 1, 'set'); finish(seed, 'seed');
  const reader = frame(state, log), observed = reader.read([], 'value'); reader.noteRead([], 'value');
  const sibling = frame(state, log);
  sibling.write(['value'], 2, 'set'); sibling.write(['late'], true, 'set'); finish(sibling, 'sibling');
  // Absent from the pinned view, this second key is delivered by live fallback after the sibling.
  const late = reader.read([], 'late'); reader.noteRead([], 'late');
  reader.write(['result'], observed, 'set'); finish(reader, 'reader');

  const record = evidence(state, log, step('seed', {}, step('sibling', {}, step('reader', { value: observed, late }))));
  assert.equal(observed, 1); assert.equal(late, true);
  const walked = backwalk(record, 'result'), serialized = sliceToJSON(walked.slice);
  const candidates = serialized.edges!.filter(edge => edge.from === 'reader#0' && edge.key === 'value');
  assert.deepEqual(candidates.map(edge => ({ id: edge.to, overlap: edge.overlap })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'seed#0', overlap: 'replaced-while-running' }, { id: 'sibling#0', overlap: 'written-while-running' },
  ]);
  assert.ok(serialized.notes?.some(note => note.code === 'concurrent-write'));
  assert.match(walked.text, /possibl/i);
  assert.equal(explainRun(record, 'result').externalRootCause, 'not-established');
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { EmitEvent } from 'footprintjs';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { compileGraph } from '../src/graph/compile.ts';
import { backwalk, loadEvidence } from '../src/evidence.ts';
import { checkConnections, createConnectionRecorder, ConnectionCheckError, CONNECTION_EVENT, type ConnectionObservation } from '../src/connections/index.ts';

const observation = (target = 'http://fixture/health'): ConnectionObservation => ({
  method: 'fixture HTTP request', target, observedAt: Date.now(), latencyMs: 2, details: { status: 200, sourcePod: 'fixture-pod' },
});
function graph(two = false) {
  return compileGraph({ name: 'connection-fixture', boundaries: [], memberships: [], resources: [
    { id: 'service', provider: 'fixture', spec: { kind: 'Service' } },
    { id: 'application', provider: 'fixture', spec: { kind: 'Deployment' } },
    { id: 'other', provider: 'fixture', spec: { kind: 'Deployment' } },
  ], relations: [
    { from: 'service', to: 'application', kind: 'communicatesWith' },
    ...(two ? [{ from: 'service', to: 'other', kind: 'communicatesWith' as const }] : []),
  ] });
}

test('a connection remains checking until its real adapter settles; native trace replay preserves observations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  const recorder = createConnectionRecorder();
  const received: string[] = [];
  recorder.subscribe(event => { received.push(event.status); });
  recorder.subscribe(() => { throw new Error('Disconnected view'); });
  const apply = checkConnections({ graph: graph(), recorders: [recorder], traceDirectory: directory,
    adapter: { async check(request) {
      assert.equal(request.stack, 'connection-fixture');
      assert.ok(Object.isFrozen(request) && Object.isFrozen(request.from.spec));
      waiting = true; await gate; return observation();
    } } });
  for (let i = 0; !waiting && i < 100; i++) await delay(2);
  assert.equal(waiting, true);
  assert.deepEqual(received, ['checking']);
  assert.equal(recorder.getSnapshot().connections['communication:0']?.status, 'checking');
  release(); const result = await apply;
  assert.equal(result.ok, true); assert.equal(result.checks['communication:0']?.status, 'connected');
  assert.deepEqual(received, ['checking', 'connected']);
  assert.equal(recorder.getSnapshot().subscriberFailures, 2);
  assert.ok(result.events.every(event => event.runtimeStageId.includes('#')));
  assert.deepEqual(stateAt(result.snapshot, result.snapshot.commitLog.length - 1).state, result.snapshot.sharedState);
  assert.ok(result.traceStatus?.flushed);
  const streamed = readStoredRecord(readRecordFile(result.tracePath!).entries).root(result.snapshot.runId!);
  assert.ok(streamed?.complete);
  assert.deepEqual(stateAt(streamed, streamed.commitLog.length - 1).state, result.snapshot.sharedState);
  const evidencePath = join(directory, 'connection-run.json');
  await writeFile(evidencePath, JSON.stringify(result));
  const evidence = await loadEvidence(evidencePath);
  assert.equal(evidence.stack, 'connection-fixture');
  const walked = backwalk(evidence, 'progress:communication:0');
  assert.match(walked.text, /request:communication:0/);
  assert.match(walked.text, /observation:communication:0/);
  const snapshot = recorder.getSnapshot();
  assert.ok(Object.isFrozen(snapshot.events[1]?.observation?.details));
  assert.deepEqual(recorder.getEvents(1), snapshot.events.slice(1));
  assert.ok(JSON.parse(await readFile(evidencePath, 'utf8')).structure);
});

test('failed checks retain actual error details and governing decisions while later connections still run', async () => {
  let calls = 0;
  const measured = { ...observation('http://fixture:5999/health'), details: { stage: 'http', targetPort: 5999, error: 'ETIMEDOUT' } };
  const failure = new ConnectionCheckError('Service HTTP request timed out', measured,
    { phase: 'http', sourcePodUid: 'uid-source', dns: ['10.0.0.1'] });
  const result = await checkConnections({ graph: graph(true), adapter: { async check() {
    if (++calls === 1) throw failure;
    return observation('http://other/health');
  } } });
  assert.equal(result.ok, false); assert.equal(calls, 2);
  assert.deepEqual(result.events.map(event => event.status), ['checking', 'failed', 'checking', 'connected']);
  assert.equal(result.checks['communication:0']?.error, failure.message);
  assert.deepEqual(result.checks['communication:0']?.details, failure.details);
  assert.equal(result.checks['communication:1']?.status, 'connected');
  assert.deepEqual(result.events[1]?.details, failure.details);
  assert.deepEqual(result.events[1]?.observation, measured);
  assert.equal(result.events[1]?.status, 'failed');
  const walked = backwalk(result as Parameters<typeof backwalk>[0], 'progress:communication:0');
  assert.match(walked.text, /error:communication:0/);
  assert.match(walked.text, /observation:communication:0/);
  assert.match(walked.text, /request:communication:0/);
  assert.ok(Object.keys(result.controlDeps).length);
  assert.ok(JSON.stringify(result.decisions).includes('failed-communication:0'));
});

test('invalid graphs are refused before checks; invalid observations become failed outcomes instead of connected', async () => {
  let calls = 0, getters = 0;
  const changed = structuredClone(graph()); changed.name = 'changed';
  const adapter = { async check() { calls++; return observation(); } };
  await assert.rejects(() => checkConnections({ graph: changed, adapter }), /digest/);
  const accessor = { ...graph() }; Object.defineProperty(accessor, 'resources', { enumerable: true, get() { getters++; return []; } });
  await assert.rejects(() => checkConnections({ graph: accessor, adapter }), /accessors/);
  assert.equal(calls, 0); assert.equal(getters, 0);
  const invalid = await checkConnections({ graph: graph(), adapter: { async check() { return { ...observation(), latencyMs: -1 }; } } });
  assert.equal(invalid.ok, false); assert.deepEqual(invalid.events.map(event => event.status), ['checking', 'failed']);
  assert.match(invalid.checks['communication:0']!.error!, /invalid observation/);
});

function native(payload: unknown): EmitEvent {
  return { name: CONNECTION_EVENT, payload, timestamp: 1, runtimeStageId: 'probe#0', stageName: 'probe', pipelineId: 'native', subflowPath: [] };
}
test('native projection refuses invented success, accessors and cross-run events and resets on a fresh executor', async () => {
  const recorder = createConnectionRecorder();
  const payload = { version: 1, runId: 'first', connectionId: 'communication:42', from: 'service', to: 'app', status: 'checking' };
  recorder.onEmit!(native(payload));
  recorder.onEmit!(native({ ...payload, runId: 'other' }));
  recorder.onEmit!(native({ ...payload, status: 'connected' }));
  let getters = 0;
  recorder.onEmit!(native({ ...payload, get message() { getters++; return 'hidden'; } }));
  assert.equal(getters, 0); assert.equal(recorder.getSnapshot().ignoredEvents, 3);
  assert.equal(recorder.getSnapshot().connections['communication:42']?.status, 'checking');
  assert.throws(() => recorder.getEvents(-1), /nonnegative/);
  const first = await checkConnections({ graph: graph(), adapter: { async check() { return observation(); } }, recorders: [recorder] });
  const second = await checkConnections({ graph: graph(), adapter: { async check() { return observation(); } }, recorders: [recorder] });
  assert.notEqual(first.runId, second.runId);
  assert.equal(recorder.getSnapshot().ignoredEvents, 0);
  assert.equal(recorder.getSnapshot().sequence, 2);
  assert.equal(recorder.getSnapshot().runId, second.runId);
  await assert.rejects(() => checkConnections({ graph: graph(), adapter: { async check() { return observation(); } }, recorders: [recorder, recorder] }), /Duplicate/);
});

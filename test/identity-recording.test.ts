import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { EmitEvent } from 'footprintjs';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { backwalk, loadEvidence, replay } from '../src/evidence.ts';
import { authorizeAccess, checkIdentityAccess, createIdentityRecorder, IDENTITY_EVENT, type IdentityCheckRequest, type AccessObservation } from '../src/identity/index.ts';

const checks: readonly IdentityCheckRequest[] = [
  { id: 'login', label: 'Directory login', kind: 'login', expected: 'authenticated' },
  { id: 'allowed', label: 'Read permitted', kind: 'access', expected: 'allowed' },
  { id: 'denied', label: 'Write refused', kind: 'access', expected: 'denied' },
];
const observation = (verdict: AccessObservation['verdict']): AccessObservation => ({ verdict, observedAt: Date.now(), latencyMs: 1,
  details: { sourceId: 'neo-directory', httpStatus: verdict === 'denied' ? 403 : 200, phase: verdict === 'authenticated' ? 'authentication' : 'authorization' } });

test('identity checks remain checking until measured and expected denial passes, with replayable native evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-identity-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let release!: () => void, waiting = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const recorder = createIdentityRecorder(); const received: string[] = [];
  recorder.subscribe(event => received.push(event.status));
  recorder.subscribe(() => { throw new Error('Disconnected display'); });
  const operation = checkIdentityAccess({ stack: 'neo', checks, recorders: [recorder], traceDirectory: directory,
    adapter: { async check(request) {
      assert.ok(Object.isFrozen(request));
      if (request.id === 'login') { waiting = true; await gate; }
      return observation(request.expected);
    } } });
  for (let i = 0; !waiting && i < 100; i++) await delay(2);
  assert.equal(waiting, true); assert.deepEqual(received, ['checking']);
  release(); const result = await operation;
  assert.equal(result.ok, true); assert.equal(result.checks.denied!.status, 'passed');
  assert.equal(result.checks.denied!.observation.verdict, 'denied');
  assert.deepEqual(received, ['checking', 'passed', 'checking', 'passed', 'checking', 'passed']);
  assert.equal(recorder.getSnapshot().subscriberFailures, 6);
  assert.ok(result.traceStatus?.flushed);
  const native = readStoredRecord(readRecordFile(result.tracePath!).entries).root(result.snapshot.runId!);
  assert.ok(native?.complete);
  assert.deepEqual(stateAt(native, native.commitLog.length - 1).state, result.snapshot.sharedState);
  const path = join(directory, 'run.json'); await writeFile(path, JSON.stringify(result));
  const evidence = await loadEvidence(path);
  assert.deepEqual(replay(evidence).state, result.snapshot.sharedState);
  const walked = backwalk(evidence, 'progress:denied');
  assert.match(walked.text, /request:denied/); assert.match(walked.text, /observation:denied/);
  assert.ok(JSON.stringify(result.decisions).includes('passed-denied'));
  assert.ok(Object.isFrozen(recorder.getSnapshot().checks.denied!.observation!.details));
});

test('unavailable is not rejected or denied, later checks continue, and recovery needs a new real observation', async () => {
  let healthy = false, calls = 0;
  const adapter = { async check(request: IdentityCheckRequest) { calls++; return { ...observation(healthy ? request.expected : 'unavailable'),
    details: healthy ? { code: 'verified' as const } : { code: 'provider-unavailable' as const } }; } };
  const first = await checkIdentityAccess({ stack: 'neo', checks, adapter });
  assert.equal(first.ok, false); assert.equal(calls, 3);
  assert.ok(Object.values(first.checks).every(check => check.status === 'failed'));
  assert.equal(first.checks.denied!.observation.verdict, 'unavailable');
  healthy = true;
  const recovered = await checkIdentityAccess({ stack: 'neo', checks, adapter });
  assert.equal(recovered.ok, true); assert.notEqual(first.runId, recovered.runId);
  assert.equal(first.checks.login!.status, 'failed');
});

test('credential closures, raw provider exceptions, bodies and extra observation fields never enter native evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-identity-private-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const password = 'password-do-not-record-123', token = 'bearer-do-not-record-123';
  let i = 0;
  const result = await checkIdentityAccess({ stack: 'neo', checks, traceDirectory: directory, adapter: { async check() {
    if (++i === 1) throw new Error(`Provider error ${password} ${token}`);
    if (i === 2) return { ...observation('allowed'), responseBody: { password, token } } as AccessObservation;
    return { ...observation('denied'), details: { ...observation('denied').details, password } } as AccessObservation;
  } } });
  assert.equal(result.ok, false);
  assert.equal(result.checks.login!.observation.details!.code, 'adapter-failure');
  assert.equal(result.checks.allowed!.observation.details!.code, 'invalid-observation');
  assert.equal(result.checks.denied!.observation.details!.code, 'invalid-observation');
  const saved = JSON.stringify(result) + await readFile(result.tracePath!, 'utf8');
  assert.ok(!saved.includes(password)); assert.ok(!saved.includes(token)); assert.ok(!saved.includes('responseBody'));
});

test('admission rejects invalid declarations before observation and isolates recorder subscriptions and runs', async () => {
  let calls = 0; const adapter = { async check() { calls++; return observation('authenticated'); } };
  for (const entries of [[], [checks[0]!, checks[0]!], [{ ...checks[0]!, kind: 'access' }], [{ ...checks[0]!, password: 'secret' }]]) {
    await assert.rejects(() => checkIdentityAccess({ stack: 'neo', checks: entries as never, adapter }));
  }
  assert.equal(calls, 0);
  const recorder = createIdentityRecorder();
  await assert.rejects(() => checkIdentityAccess({ stack: 'neo', checks: [checks[0]!], adapter, recorders: [recorder, recorder] }), /Duplicate/);
  const first = await checkIdentityAccess({ stack: 'neo', checks: [checks[0]!], adapter, recorders: [recorder] });
  const second = await checkIdentityAccess({ stack: 'neo', checks: [checks[0]!], adapter, recorders: [recorder] });
  assert.notEqual(first.runId, second.runId); assert.equal(recorder.getSnapshot().runId, second.runId);
  assert.equal(recorder.getSnapshot().sequence, 2); assert.equal(recorder.getSnapshot().ignoredEvents, 0);
  assert.throws(() => recorder.getEvents(-1), /nonnegative/);
  assert.deepEqual(recorder.getEvents(1), second.events.slice(1));
});

function native(payload: unknown): EmitEvent {
  return { name: IDENTITY_EVENT, payload, timestamp: 1, runtimeStageId: 'observe#0', stageName: 'observe', pipelineId: 'native', subflowPath: [] };
}
test('native identity projection refuses invented passes, inconsistent expected outcomes, raw messages and cross-run events', () => {
  const recorder = createIdentityRecorder();
  const base = { version: 1, runId: 'first', checkId: 'login', label: 'Login', kind: 'login', expected: 'authenticated', status: 'checking' };
  recorder.onEmit!(native(base));
  recorder.onEmit!(native({ ...base, runId: 'other' }));
  recorder.onEmit!(native({ ...base, status: 'passed' }));
  recorder.onEmit!(native({ ...base, status: 'passed', observation: observation('rejected') }));
  recorder.onEmit!(native({ ...base, status: 'failed', observation: observation('rejected'), message: 'raw credential error' }));
  let getters = 0;
  recorder.onEmit!(native({ ...base, get message() { getters++; return 'secret'; } }));
  assert.equal(getters, 0); assert.equal(recorder.getSnapshot().ignoredEvents, 5);
  assert.equal(recorder.getSnapshot().checks.login!.status, 'checking');
});

test('real permission evaluation records policy, verified groups and request as causal reads, including explicit-deny branch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-authorization-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = { id: 'neo-policy', rules: [
    { id: 'readers', effect: 'allow' as const, source: 'neo-directory', groups: ['readers'], actions: ['chat.read'], resources: ['neo'] },
    { id: 'suspended', effect: 'deny' as const, source: 'neo-directory', groups: ['suspended'], actions: ['chat.read'], resources: ['neo'] },
  ] };
  const allowed = await authorizeAccess({ policy, subject: { id: 'rahul', source: 'neo-directory', groups: ['readers'] }, action: 'chat.read', resource: 'neo', traceDirectory: directory });
  assert.equal(allowed.decision.effect, 'allowed');
  const denied = await authorizeAccess({ policy, subject: { id: 'rahul', source: 'neo-directory', groups: ['readers', 'suspended'] }, action: 'chat.read', resource: 'neo', traceDirectory: directory });
  assert.equal(denied.decision.reason, 'explicit-deny');
  assert.deepEqual(denied.decision.matchedRuleIds, ['suspended']);
  const path = join(directory, 'authorization.json'); await writeFile(path, JSON.stringify(denied));
  const evidence = await loadEvidence(path), walked = backwalk(evidence, 'outcome');
  for (const key of ['policy', 'subject', 'action', 'resource', 'decision']) assert.ok(walked.text.includes(key));
  assert.ok(JSON.stringify(denied.decisions).includes('access-denied'));
  const native = readStoredRecord(readRecordFile(denied.tracePath!).entries).root(denied.snapshot.runId!);
  assert.ok(native?.complete);
  assert.deepEqual(stateAt(native, native.commitLog.length - 1).state, denied.snapshot.sharedState);
  assert.deepEqual(replay(evidence).state, denied.snapshot.sharedState);
});

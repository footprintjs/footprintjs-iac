import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { flattenCausalDAG, readStoredRecord, stateAt, type ControlDependency } from 'foottrace';
import { checkConnections } from '../src/connections/index.ts';
import { checkIdentityAccess, type IdentityCheckRequest } from '../src/identity/index.ts';
import { compileGraph } from '../src/graph/compile.ts';
import { backwalk, replay, type RunEvidence } from '../src/evidence.ts';

const outcomes = [true, true, false, false, true, true];
type Decision = { deciderRuntimeStageId: string; evidence: { rules: { inputs: { key: string }[] }[] } };

function assertOwnDecision(evidence: RunEvidence, id: string, terminalRuntimeStageId: string, probeStageId: string) {
  const dependency = evidence.controlDeps[terminalRuntimeStageId] as ControlDependency;
  assert.ok(dependency); assert.ok(dependency.deciderId.startsWith(`outcome-${id}#`));
  const walked = backwalk(evidence, `progress:${id}`), root = walked.slice.root;
  assert.ok(root);
  const control = root.parentEdges.find(edge => edge.kind === 'control');
  assert.equal(control?.parent.runtimeStageId, dependency.deciderId);
  const parentReads = control!.parent.parentEdges.filter(edge => edge.kind === 'data');
  assert.ok(parentReads.some(edge => edge.key === `result:${id}` && edge.parent.stageId === probeStageId),
    'The governing decision must read this exact check result, including when adjacent verdicts are equal');
  assert.ok(parentReads.every(edge => edge.parent.stageId === probeStageId), 'The governing decision must not inherit a prior check outcome');
  const nodes = flattenCausalDAG(root);
  assert.deepEqual(nodes.filter(node => node.stageId.startsWith('probe-') || node.stageId.startsWith('observe-')).map(node => node.stageId), [probeStageId]);
  const decision = (evidence.decisions as Decision[]).find(item => item.deciderRuntimeStageId === dependency.deciderId);
  assert.ok(decision?.evidence.rules.some(rule => rule.inputs.some(input => input.key === `result:${id}`)));
}

function assertNativeReplay(evidence: RunEvidence) {
  const file = readRecordFile(evidence.tracePath!); assert.deepEqual(file.unreadable, []);
  const stored = readStoredRecord(file.entries); assert.deepEqual(stored.unread, []);
  const native = [...stored.logs.values()].find(log => log.address.drillPath.length === 0);
  assert.ok(native?.complete); assert.deepEqual(native.gaps, []);
  assert.equal(native.commitLog.length, evidence.snapshot.commitLog.length);
  for (let commit = 0; commit < native.commitLog.length; commit++) assert.deepEqual(stateAt(native.source(), commit).state, replay(evidence, commit).state);
}

test('consecutive equal connection successes and failures attribute each native decision only to its own measured probe', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'connection-decision-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const graph = compileGraph({ name: 'decision-connections', boundaries: [], memberships: [], resources: [
    { id: 'service', provider: 'fixture', spec: {} }, ...outcomes.map((_, index) => ({ id: `app-${index}`, provider: 'fixture', spec: {} })),
  ], relations: outcomes.map((_, index) => ({ from: 'service', to: `app-${index}`, kind: 'communicatesWith' as const })) });
  const result = await checkConnections({ graph, traceDirectory: directory, adapter: { async check(request) {
    const index = Number(request.to.id.slice('app-'.length)); if (!outcomes[index]) throw Error('Measured connection failure');
    return { method: 'fixture network observation', target: request.to.id, observedAt: 123, latencyMs: 2, details: { verified: true } };
  } } });
  const evidence = result as RunEvidence;
  assert.deepEqual(Object.values(result.checks).map(check => check.status), outcomes.map(ok => ok ? 'connected' : 'failed'));
  for (const event of result.events.filter(event => event.status !== 'checking')) assertOwnDecision(evidence, event.connectionId, event.runtimeStageId, `probe-${event.connectionId}`);
  assertNativeReplay(evidence);
});

test('consecutive equal identity successes and failures attribute each native decision only to its own access observation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-decision-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const checks: IdentityCheckRequest[] = outcomes.map((_, index) => ({ id: `access-${index}`, label: `Access ${index}`, kind: 'access', expected: 'allowed' }));
  const result = await checkIdentityAccess({ stack: 'decision-identity', checks, traceDirectory: directory, adapter: { async check(request) {
    return { verdict: outcomes[Number(request.id.slice('access-'.length))] ? 'allowed' : 'unavailable', observedAt: 123, latencyMs: 2, details: { code: 'verified' } };
  } } });
  const evidence = result as unknown as RunEvidence;
  assert.deepEqual(Object.values(result.checks).map(check => check.status), outcomes.map(ok => ok ? 'passed' : 'failed'));
  for (const event of result.events.filter(event => event.status !== 'checking')) assertOwnDecision(evidence, event.checkId, event.runtimeStageId, `observe-${event.checkId}`);
  assertNativeReplay(evidence);
});

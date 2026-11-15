import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprint } from '../src/util.ts';
import { loadEvidence } from '../src/evidence.ts';
import { verifyEvidenceTrace } from '../src/evidence-trace.ts';
import { defineAgentRevision, defineAgentDeployment, AGENT_CAPABILITIES, type AgentEnvironmentAdapters } from '../src/agent-platform/index.ts';
import { AgentReadinessWorkflow, FileResourceFlowStore } from '../src/agent-platform/node.ts';

async function fixture(t: { after(work: () => Promise<void>): void }, human = false) {
 const directory = await mkdtemp(join(tmpdir(), 'iac-agent-platform-')); t.after(() => rm(directory, { recursive: true, force: true }));
 const body = { kind: 'infra-graph' as const, version: 1 as const, name: 'neo-agent-platform',
  resources: [{ id: 'neo-runtime', provider: 'simulator', spec: { image: 'reviewed-neo-image' } }], boundaries: [], memberships: [], relations: [] };
 const graph = { ...body, digest: fingerprint(body) };
 const revisionInput = { agentId: 'neo', behavior: { id: 'triage', digest: 'a'.repeat(64), reference: 'artifact:behavior-one' }, runtime: { id: 'node-runtime', digest: 'b'.repeat(64), reference: 'artifact:runtime-one' } };
 const revision = defineAgentRevision(revisionInput);
 const input = { id: 'neo-local-agent', label: 'Neo agent', revision, target: { id: 'owned-local-target', scope: 'pinned-local-scope' },
  resourceIds: ['neo-runtime'], environmentResourceId: 'neo-runtime', mode: human ? 'create' as const : 'existing' as const,
  requiredCheckIds: ['health', 'login'], requiredCapabilities: ['revisionRouting' as const] };
 const definition = defineAgentDeployment(input, graph), calls: string[] = [];
 const controls = { human, wrongBinding: false, missingCheck: false, proof: true, supported: true, verify: true };
 const handle = { id: 'neo-runtime', kind: 'agent-execution-environment', physicalId: 'owned-process/one', scope: input.target.scope };
 const adapters: AgentEnvironmentAdapters = {
  async create(context) { calls.push('create'); assert.equal(context.revisionDigest, revision.digest); return handle; },
  async find(context) { calls.push('find'); assert.equal(context.agentId, 'neo'); return handle; },
  async validate() {},
  async resolveDetails(resource, profileId) { calls.push('details'); if (controls.human && !profileId) return;
   return { profileId: 'local-access', resourceId: resource.id, endpoint: 'http://127.0.0.1:15299', protocol: 'http' }; },
  async connect(_resource, _details, context) { calls.push('connect'); assert.equal(context.deploymentDigest, definition.digest); return { id: 'registered-agent-route', runId: 'native-connect-run' }; },
  async verify(resource, _details, _connection, context) {
   calls.push('verify'); return { request: { operationId: context.operationId, agentId: context.agentId,
    revisionDigest: controls.wrongBinding ? 'c'.repeat(64) : context.revisionDigest, environmentPhysicalId: resource.physicalId, scope: resource.scope },
    ok: controls.verify, checks: [{ id: 'health', passed: controls.verify }, ...controls.missingCheck ? [] : [{ id: 'login', passed: controls.verify }]],
    capabilities: AGENT_CAPABILITIES.map(id => ({ id, status: id === 'revisionRouting' ? controls.supported ? 'supported' as const : 'unsupported' as const : 'unknown' as const,
     ...(id === 'revisionRouting' && controls.proof ? { proof: { id: 'routing-observation', runId: 'native-routing-probe', evidencePath: '/private/registered-routing-proof.json' } } : {}) })) };
  },
 };
 const store = new FileResourceFlowStore(directory), profiles = [{ id: 'local-access', label: 'Registered local access' }];
 const workflow = (selected = definition) => new AgentReadinessWorkflow({ definition: selected, graph, store, profiles, adapters });
 return { directory, graph, revisionInput, revision, input, definition, controls, calls, store, workflow, adapters };
}

test('agent revision and graph associations are immutable pure declarations', async t => {
 const f = await fixture(t); assert.equal(f.calls.length, 0); assert.ok(Object.isFrozen(f.revision)); assert.ok(Object.isFrozen(f.revision.behavior));
 f.revisionInput.behavior.reference = 'artifact:changed'; assert.equal(f.revision.behavior.reference, 'artifact:behavior-one');
 assert.notEqual(defineAgentRevision(f.revisionInput).digest, f.revision.digest);
 assert.throws(() => defineAgentDeployment({ ...f.input, resourceIds: ['not-in-graph'] }, f.graph), /agent|resource|graph/i);
 assert.throws(() => defineAgentDeployment({ ...f.input, revision: { ...f.revision, digest: 'd'.repeat(64) } }, f.graph), /agent|revision/i);
 assert.throws(() => defineAgentRevision({ ...f.revisionInput, runtime: { ...f.revisionInput.runtime, reference: 'https://user:PRIVATE-PASSWORD@example.invalid/runtime' } }), /agent|reference/i);
 const idle = await f.workflow().snapshot(); assert.equal(idle.status, 'idle'); assert.equal(idle.ready, false); assert.equal(f.calls.length, 0);
 assert.ok(idle.capabilities.every(capability => capability.status === 'unknown' && capability.source === 'unmeasured'));
});

test('agent readiness uses the native Create/Find Connect Verify flow and reopens without providers', async t => {
 const f = await fixture(t), workflow = f.workflow(), live: string[] = [], frozen: boolean[] = [];
 workflow.subscribe(state => { live.push(state.status + ':' + state.flow.stages.find(stage => stage.status === 'running')?.id); });
 workflow.subscribe(() => { throw Error('viewer unavailable'); });
 workflow.subscribe(state => { frozen.push(Object.isFrozen(state) && Object.isFrozen(state.capabilities)); });
 const result = await workflow.start(); assert.equal(result.status, 'ready'); assert.equal(result.ready, true);
 assert.equal(result.flow.status, 'passed'); assert.equal(result.revision.digest, f.revision.digest);
 assert.equal(result.capabilities.find(capability => capability.id === 'revisionRouting')?.status, 'supported');
 assert.equal(result.capabilities.find(capability => capability.id === 'processMemoryRestore')?.status, 'unknown');
 assert.ok(live.includes('running:connect')); assert.equal(result.flow.events.length, 8);
 assert.ok(frozen.length > 0 && frozen.every(Boolean)); assert.ok(Object.isFrozen(result));
 const segment = result.flow.segments[0]!, evidence = await loadEvidence(segment.evidencePath); await verifyEvidenceTrace(evidence);
 const binding = evidence.snapshot.recorders?.find(recorder => recorder.id === 'iac-agent-revision-binding')?.data as { definition?: { digest?: string } };
 assert.equal(binding.definition?.digest, f.definition.digest);
 const count = f.calls.length, reopened = await f.workflow().snapshot(); assert.equal(reopened.ready, true); assert.equal(f.calls.length, count);
 await assert.rejects(() => f.workflow().start(), /already started/);
});

test('missing required measured checks cannot mark an agent ready', async t => {
 const f = await fixture(t); f.controls.missingCheck = true;
 const result = await f.workflow().start(); assert.equal(result.status, 'failed'); assert.equal(result.ready, false);
 assert.ok(result.flow.verification?.checks.some(check => check.id === 'agent-required-check.login' && !check.passed));
});

test('unsupported required capability and supported claims without a proof both fail closed', async t => {
 const f = await fixture(t); f.controls.supported = false;
 const result = await f.workflow().start(); assert.equal(result.status, 'failed'); assert.equal(result.ready, false);
 assert.equal(result.capabilities.find(capability => capability.id === 'revisionRouting')?.status, 'unsupported');
 const missing = await fixture(t); missing.controls.proof = false;
 const failed = await missing.workflow().start(); assert.equal(failed.ready, false); assert.equal(failed.flow.stages.at(-1)?.status, 'failed');
});

test('a verification for another pinned revision is refused before readiness', async t => {
 const f = await fixture(t); f.controls.wrongBinding = true;
 const state = await f.workflow().start(); assert.equal(state.ready, false); assert.equal(state.status, 'failed');
 assert.equal(state.flow.verification, undefined);
});

test('a native human pause resumes the pinned agent environment once and rejects another revision', async t => {
 const f = await fixture(t, true), paused = await f.workflow().start(); assert.equal(paused.status, 'paused'); assert.ok(paused.flow.pause);
 const changed = defineAgentDeployment({ ...f.input, revision: defineAgentRevision({ ...f.revisionInput, behavior: { ...f.revisionInput.behavior, digest: 'c'.repeat(64) } }) }, f.graph);
 await assert.rejects(() => f.workflow(changed).resume({ pauseToken: paused.flow.pause!.token, profileId: 'local-access' }), /changed|definition/);
 assert.equal(f.calls.filter(call => call === 'create').length, 1); assert.equal(f.calls.includes('connect'), false);
 const resumed = await f.workflow().resume({ pauseToken: paused.flow.pause!.token, profileId: 'local-access' });
 assert.equal(resumed.ready, true); assert.equal(resumed.flow.segments.length, 2); assert.equal(f.calls.filter(call => call === 'create').length, 1);
 assert.equal(resumed.flow.segments[1]?.resumedFromRunId, paused.flow.segments[0]?.runId);
});

test('a wrong native run or a missing native verification recording cannot promote retained readiness', async t => {
 const f = await fixture(t), ready = await f.workflow().start(); assert.equal(ready.ready, true);
 const stored = JSON.parse(await readFile(f.store.path, 'utf8')); stored.state.segments[0].runId = 'another-run';
 await writeFile(f.store.path, JSON.stringify(stored)); await assert.rejects(() => f.workflow().snapshot(), /native|record|run|binding/i);
 const second = await fixture(t), result = await second.workflow().start();
 await rm(result.flow.segments[0]!.evidencePath); await assert.rejects(() => second.workflow().snapshot(), /ENOENT|native|record/i);
});

test('registered domain capabilities are measured without changing the four unknown baseline capabilities', async t => {
 const f = await fixture(t), definition = defineAgentDeployment({ ...f.input, capabilityIds: ['conversationAuthorization'], requiredCapabilities: ['conversationAuthorization'] }, f.graph);
 assert.equal(definition.capabilityIds.length, 5);
 const actualPorts: AgentEnvironmentAdapters = {
  async find() { return { id: 'neo-runtime', kind: 'agent-runtime', physicalId: 'neo/one', scope: definition.target.scope }; }, async validate() {},
  async resolveDetails(resource) { return { profileId: 'local-access', resourceId: resource.id, endpoint: 'http://127.0.0.1:15299', protocol: 'http' }; },
  async connect() { return { id: 'measured-route', runId: 'connection-proof' }; },
  async verify(resource, _details, _connection, context) { return {
   request: { operationId: context.operationId, agentId: context.agentId, revisionDigest: context.revisionDigest, environmentPhysicalId: resource.physicalId, scope: resource.scope },
   ok: true, checks: [{ id: 'health', passed: true }, { id: 'login', passed: true }],
   capabilities: [{ id: 'conversationAuthorization', status: 'supported', proof: { id: 'two-user-access-proof', runId: 'native-access-run' } }],
  }; },
 };
 const workflow = new AgentReadinessWorkflow({ definition, graph: f.graph, store: f.store, profiles: [{ id: 'local-access', label: 'Local access' }], adapters: actualPorts });
 const ready = await workflow.start(); assert.equal(ready.ready, true);
 assert.equal(ready.capabilities.find(capability => capability.id === 'conversationAuthorization')?.status, 'supported');
 assert.ok(AGENT_CAPABILITIES.every(id => ready.capabilities.find(capability => capability.id === id)?.status === 'unknown'));
 const reopened = await workflow.snapshot(); assert.equal(reopened.ready, true);
 assert.throws(() => defineAgentDeployment({ ...f.input, requiredCapabilities: ['unregisteredCapability'] }, f.graph), /agent/i);
 assert.throws(() => defineAgentDeployment({ ...f.input, capabilityIds: ['unsafe.identifier'] }, f.graph), /agent/i);
});

test('retained event timestamps and verification cannot be rewritten outside native capture', async t => {
 const f = await fixture(t); await f.workflow().start();
 const saved = JSON.parse(await readFile(f.store.path, 'utf8')); saved.state.events[0].timestamp += 100;
 await writeFile(f.store.path, JSON.stringify(saved)); await assert.rejects(() => f.workflow().snapshot(), /events|record/i);
 const other = await fixture(t); await other.workflow().start();
 const edited = JSON.parse(await readFile(other.store.path, 'utf8')); edited.state.verification.checks.find((check: { id: string }) => check.id === 'login').passed = false;
 edited.state.verification.ok = false;
 await writeFile(other.store.path, JSON.stringify(edited)); await assert.rejects(() => other.workflow().snapshot(), /native|record|Unsupported/i);
});

test('a retained running intent is uncertain on a new reader while only the driving instance is live', async t => {
 const f = await fixture(t), find = f.adapters.find;
 let release!: () => void, entered!: () => void, first = true;
 const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
 f.adapters.find = async context => { if (first) { first = false; entered(); await gate; } return find(context); };
 const workflow = f.workflow(), running = workflow.start();
 try {
  await reached;
  assert.equal((await workflow.snapshot()).status, 'running');
  await assert.rejects(() => workflow.start(), /already running/);
  const count = f.calls.length, retained = await f.workflow().snapshot();
  assert.equal(retained.status, 'incomplete'); assert.equal(retained.ready, false); assert.equal(retained.flow.status, 'running');
  assert.equal(f.calls.length, count);
 } finally { release(); await running; }
 assert.equal((await running).ready, true);
});

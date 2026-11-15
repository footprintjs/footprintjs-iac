import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../src/util.ts';
import { defineAgentRevision, defineAgentDeployment } from '../src/agent-platform/data.ts';
import type { AgentEnvironmentAdapters } from '../src/agent-platform/types.ts';
import { defineAgentComponentGraph, readAgentComponentGraph } from '../src/agent-platform/components/declaration.ts';
import { projectAgentComponents } from '../src/agent-platform/components/projection.ts';
import { AgentComponentsWorkflow } from '../src/agent-platform/components/workflow.ts';
import { loadEvidence } from '../src/evidence.ts';
import { verifyEvidenceTrace } from '../src/evidence-trace.ts';

async function fixture(t: { after(work: () => Promise<void>): void }, config: { human?: boolean; humanBoth?: boolean; parallel?: boolean; failed?: string } = {}) {
 const directory = await mkdtemp(join(tmpdir(), 'iac-agent-components-')); t.after(() => rm(directory, { recursive: true, force: true }));
 const body = { kind: 'infra-graph' as const, version: 1 as const, name: 'agent-components', resources: [{ id: 'runtime', provider: 'simulator', spec: { image: 'reviewed' } }], boundaries: [], memberships: [], relations: [] };
 const graph = { ...body, digest: fingerprint(body) }, revision = defineAgentRevision({ agentId: 'neo', behavior: { id: 'behavior', digest: 'a'.repeat(64) }, runtime: { id: 'runtime', digest: 'b'.repeat(64) } });
 const deployment = defineAgentDeployment({ id: 'neo-deployment', label: 'Neo', revision, target: { id: 'registered', scope: 'pinned' }, resourceIds: ['runtime'], environmentResourceId: 'runtime', mode: 'existing', requiredCheckIds: ['health'] }, graph);
 const component = (id: string, kind: 'execution' | 'store' | 'connection', roles: string[]) => ({ id, label: id, kind, roles, mode: (id === 'session' && config.human || config.humanBoth && id !== 'worker') ? 'create' as const : 'existing' as const, resourceIds: ['runtime'], environmentResourceId: 'runtime', requiredCheckIds: ['health'], required: true, boundaryId: 'runtime-boundary' });
 const input = { id: 'neo-components', label: 'Neo components', components: [component('worker', 'execution', ['worker']), { ...component('session', 'store', ['session-state', 'conversation-history']), storage: 'memory' as const, sharing: 'shared' as const }, component('tools', 'connection', ['tools'])],
  boundaries: [{ id: 'runtime-boundary', label: 'Registered runtime', kind: 'service' as const, strategy: { id: 'registered-runtime', label: 'Registered runtime' }, realizedBy: 'worker', requiredCheckIds: ['health'] }],
  relations: [{ id: 'worker-session', from: 'worker', to: 'session', kind: 'order' as const }, { id: 'worker-tools', from: 'worker', to: 'tools', kind: 'order' as const },
   { id: 'tool-route', from: 'worker', to: 'tools', kind: 'communicatesWith' as const, required: true, checkComponentId: 'tools' }] };
 const definition = defineAgentComponentGraph(input, deployment, graph), calls: string[] = [];
 let arrived = 0, release!: () => void; const overlap = new Promise<void>(resolve => { release = resolve; });
 const components = Object.fromEntries(input.components.map(component => {
  const handle = { id: 'runtime', kind: component.kind, physicalId: `registered/${component.id}`, scope: 'pinned' };
  const adapters: AgentEnvironmentAdapters = {
   async create() { calls.push(component.id + ':create'); return handle; },
   async find() { calls.push(component.id + ':find-start'); if (config.parallel && component.id !== 'worker' && arrived < 2) { arrived++; if (arrived === 2) release(); await overlap; } calls.push(component.id + ':find-end'); if (config.failed === component.id) throw Error('PRIVATE-PROVIDER-FAILURE'); return handle; },
   async validate() {},
   async resolveDetails(resource, profileId) { if ((config.human && component.id === 'session' || config.humanBoth && component.id !== 'worker') && !profileId) return;
    return { profileId: 'local', resourceId: resource.id, endpoint: 'http://127.0.0.1:15000', protocol: 'http' }; },
   async connect() { calls.push(component.id + ':connect'); return { id: component.id + '-connection', runId: 'native-connection-proof' }; },
   async verify(resource, _details, _receipt, context) { calls.push(component.id + ':verify'); return { request: { operationId: context.operationId, agentId: context.agentId, revisionDigest: context.revisionDigest, environmentPhysicalId: resource.physicalId, scope: resource.scope }, ok: true, checks: [{ id: 'health', passed: true }], capabilities: [] }; },
  };
  return [component.id, { profiles: [{ id: 'local', label: 'Local access' }], adapters }];
 }));
 const options = { definition, deployment, graph, directory, components, maxConcurrency: 4 };
 return { directory, graph, deployment, input, definition, components, calls, options, workflow: () => new AgentComponentsWorkflow(options) };
}

test('component graph is a pure bound declaration with separate topology and deployment dependencies', async t => {
 const f = await fixture(t); assert.equal(f.calls.length, 0); assert.ok(Object.isFrozen(f.definition)); assert.ok(Object.isFrozen(f.definition.components[0]));
 assert.deepEqual(readAgentComponentGraph(f.definition, f.deployment, f.graph), f.definition);
 assert.throws(() => defineAgentComponentGraph({ ...f.input, relations: [...f.input.relations, { id: 'cycle', from: 'session', to: 'worker', kind: 'order' }] }, f.deployment, f.graph), /component/);
 assert.throws(() => defineAgentComponentGraph({ ...f.input, boundaries: [{ ...f.input.boundaries[0]!, realizedBy: 'foreign' }] }, f.deployment, f.graph), /component/);
 assert.throws(() => defineAgentComponentGraph({ ...f.input, components: [{ ...f.input.components[0]!, resourceIds: ['foreign'] }] }, f.deployment, f.graph), /component/);
 assert.throws(() => defineAgentComponentGraph({ ...f.input, relations: [{ id: 'unmeasured', from: 'worker', to: 'tools', kind: 'communicatesWith', required: true }] }, f.deployment, f.graph), /component/);
 const initial = await f.workflow().snapshot(), view = projectAgentComponents(f.definition, initial);
 assert.equal(initial.status, 'idle'); assert.equal(view.boundaries[0]?.observed, false); assert.equal(view.boundaries[0]?.progress.completed, 0); assert.equal(view.boundaries[0]?.progress.total, 12); assert.equal(f.calls.length, 0);
});

test('native component subflows really overlap independent work, join and retain verified progress', async t => {
 const f = await fixture(t, { parallel: true }), workflow = f.workflow(), observed: string[] = [];
 workflow.subscribe(state => { observed.push(state.components.map(value => value.id + ':' + value.status).join(',')); });
 workflow.subscribe(() => { throw Error('broken viewer'); });
 const result = await workflow.start(); assert.equal(result.status, 'ready'); assert.equal(result.ready, true);
 const sessionStart = f.calls.indexOf('session:find-start'), toolsStart = f.calls.indexOf('tools:find-start');
 assert.ok(sessionStart >= 0 && toolsStart >= 0); assert.ok(sessionStart < f.calls.indexOf('tools:find-end')); assert.ok(toolsStart < f.calls.indexOf('session:find-end'));
 assert.ok(f.calls.indexOf('worker:verify') < sessionStart); assert.ok(observed.some(value => /session:running/.test(value) && /tools:running/.test(value)));
 const view = projectAgentComponents(f.definition, result); assert.equal(view.boundaries[0]?.status, 'ready'); assert.equal(view.boundaries[0]?.observed, true); assert.deepEqual(view.boundaries[0]?.progress, { completed: 12, total: 12, indeterminate: false, unit: 'stages' });
 assert.equal(view.relations.find(value => value.id === 'tool-route')?.status, 'connected');
 const parent = await loadEvidence(result.segments[0]!.evidencePath); await verifyEvidenceTrace(parent);
 assert.ok(JSON.stringify(parent.structure).includes('subflow')); assert.ok(JSON.stringify(parent.structure).includes('selector')); assert.ok(parent.snapshot.recorders?.some(value => value.id === 'iac-agent-components-topology'));
 assert.ok(Object.keys((parent.snapshot.sharedState['component:worker'] as { runs: Record<string, unknown> }).runs).length > 0);
 const count = f.calls.length; assert.equal((await f.workflow().snapshot()).status, 'ready'); assert.equal(f.calls.length, count);
 await assert.rejects(workflow.start(), /already started/);
});

test('real failed component state is retained, no creation fallback or fresh retry is authorized', async t => {
 const f = await fixture(t, { failed: 'worker' }), result = await f.workflow().start();
 assert.equal(result.status, 'failed'); assert.equal(result.ready, false); assert.equal(f.calls.some(value => value.endsWith(':create')), false);
 assert.equal(f.calls.some(value => value.startsWith('session:find')), false); assert.equal(result.components.find(value => value.id === 'session')?.status, 'skipped');
 assert.equal(projectAgentComponents(f.definition, result).boundaries[0]?.status, 'failed');
 assert.equal((await f.workflow().snapshot()).status, 'failed'); const before = f.calls.length; await assert.rejects(f.workflow().start(), /already started/); assert.equal(f.calls.length, before);
});

test('native component pause/resume reuses completed siblings and never recreates the paused resource', async t => {
 const f = await fixture(t, { human: true }), paused = await f.workflow().start(), component = paused.components.find(value => value.id === 'session');
 assert.equal(paused.status, 'paused'); assert.equal(component?.status, 'paused'); assert.ok(component?.readiness?.flow.pause);
 const workerCalls = f.calls.filter(value => value.startsWith('worker:')).length;
 const resumed = await f.workflow().resume({ componentId: 'session', pauseToken: component!.readiness!.flow.pause!.token, profileId: 'local' });
 assert.equal(resumed.status, 'ready'); assert.equal(f.calls.filter(value => value === 'session:create').length, 1); assert.equal(f.calls.filter(value => value.startsWith('worker:')).length, workerCalls);
 assert.equal(resumed.segments[1]?.resumedFromRunId, paused.segments[0]?.runId); assert.equal(resumed.components.find(value => value.id === 'session')?.readiness?.flow.segments.length, 2);
});

test('native component intent is not live on another reader and cannot be retried after interruption', async t => {
 const f = await fixture(t); let release!: () => void, began!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
 const find = f.components.worker!.adapters.find; f.components.worker!.adapters.find = async context => { began(); await held; return find(context); };
 const workflow = f.workflow(), running = workflow.start(); t.after(async () => { release(); await running; }); await started;
 assert.equal((await workflow.snapshot()).status, 'running'); assert.equal((await f.workflow().snapshot()).status, 'incomplete');
 await assert.rejects(f.workflow().start(), /locked|already started/); release(); assert.equal((await running).status, 'ready');
});

test('changed graph policy, native child association and missing trace cannot promote retained readiness', async t => {
 const f = await fixture(t), result = await f.workflow().start(); assert.equal(result.status, 'ready');
 await assert.rejects(new AgentComponentsWorkflow({ ...f.options, maxConcurrency: 1 }).snapshot(), /policy|changed/);
 const segment = result.components[0]!.readiness!.flow.segments[0]!, evidence = JSON.parse(await readFile(segment.evidencePath, 'utf8'));
 evidence.snapshot.recorders.find((value: { id: string }) => value.id === 'iac-agent-component-binding').data.componentGraphDigest = 'c'.repeat(64);
 await writeFile(segment.evidencePath, JSON.stringify(evidence)); await assert.rejects(f.workflow().snapshot(), /association|binding/);
 const other = await fixture(t), complete = await other.workflow().start(); await rm(complete.segments[0]!.tracePath); await assert.rejects(other.workflow().snapshot(), /ENOENT|trace/);
});


test('parallel native human pauses resume one exact child without repeating completed work', async t => {
 const f = await fixture(t, { humanBoth: true }), paused = await f.workflow().start(); assert.equal(paused.status, 'paused');
 const session = paused.components.find(value => value.id === 'session')!, tools = paused.components.find(value => value.id === 'tools')!;
 assert.equal(session.status, 'paused'); assert.equal(tools.status, 'paused');
 const one = await f.workflow().resume({ componentId: 'session', pauseToken: session.readiness!.flow.pause!.token, profileId: 'local' });
 assert.equal(one.status, 'paused'); assert.equal(one.components.find(value => value.id === 'session')?.status, 'ready'); assert.equal(one.components.find(value => value.id === 'tools')?.status, 'paused');
 const complete = await f.workflow().resume({ componentId: 'tools', pauseToken: tools.readiness!.flow.pause!.token, profileId: 'local' });
 assert.equal(complete.status, 'ready'); assert.equal(f.calls.filter(value => value === 'session:create').length, 1); assert.equal(f.calls.filter(value => value === 'tools:create').length, 1);
 assert.equal(complete.segments.length, 3);
 const envelope = JSON.parse(await readFile(join(f.directory, 'agent-components.json'), 'utf8'));
 envelope.segments[0].resumedFromRunId = 'invented-history'; await writeFile(join(f.directory, 'agent-components.json'), JSON.stringify(envelope));
 await assert.rejects(f.workflow().snapshot(), /resume|First component/);
});

test('an independent optional known failure is visible without falsifying required readiness', async t => {
 const f = await fixture(t, { failed: 'tools' });
 const definition = defineAgentComponentGraph({ ...f.input, components: f.input.components.map(value => value.id === 'tools' ? { ...value, required: false } : value),
  relations: f.input.relations.map(value => value.id === 'tool-route' ? { ...value, required: false } : value) }, f.deployment, f.graph);
 const result = await new AgentComponentsWorkflow({ ...f.options, definition }).start(); assert.equal(result.status, 'ready'); assert.equal(result.components.find(value => value.id === 'tools')?.status, 'failed');
 const projection = projectAgentComponents(definition, result); assert.equal(projection.boundaries[0]?.status, 'ready'); assert.equal(projection.boundaries[0]?.progress.total, 8); assert.equal(projection.relations.find(value => value.id === 'tool-route')?.status, 'failed');
});

test('an optional failed prerequisite still blocks required dependent work', async t => {
 const f = await fixture(t, { failed: 'tools' });
 const definition = defineAgentComponentGraph({ ...f.input, components: f.input.components.map(value => value.id === 'tools' ? { ...value, required: false } : value),
  relations: [...f.input.relations.map(value => value.id === 'tool-route' ? { ...value, required: false } : value), { id: 'tools-session', from: 'tools', to: 'session', kind: 'order' }] }, f.deployment, f.graph);
 const result = await new AgentComponentsWorkflow({ ...f.options, definition }).start(); assert.equal(result.status, 'failed'); assert.equal(result.components.find(value => value.id === 'session')?.status, 'skipped'); assert.equal(f.calls.some(value => value.startsWith('session:')), false);
});

test('declared isolation and duplicate physical store labels do not manufacture verified sandbox state', async t => {
 const f = await fixture(t);
 const isolated = defineAgentComponentGraph({ ...f.input, boundaries: [{ ...f.input.boundaries[0]!, kind: 'isolation' }] }, f.deployment, f.graph);
 const result = await new AgentComponentsWorkflow({ ...f.options, definition: isolated }).start(); assert.equal(result.status, 'failed'); assert.equal(projectAgentComponents(isolated, result).boundaries[0]?.observed, false);
 assert.throws(() => defineAgentComponentGraph({ ...f.input, components: [...f.input.components.map(value => value.id === 'session' ? { ...value, physicalGroupId: 'one-store' } : value),
  { ...f.input.components[1]!, id: 'duplicate-store', physicalGroupId: 'one-store' }] }, f.deployment, f.graph), /component/);
});

test('a verified identity anchor cannot make a boundary ready while required storage work was skipped', async t => {
 const f = await fixture(t, { failed: 'tools' });
 const definition = defineAgentComponentGraph({ ...f.input,
  components: f.input.components.map(value => value.id === 'session' ? { ...value, boundaryId: 'storage-boundary' } : value),
  boundaries: [...f.input.boundaries, { id: 'storage-boundary', label: 'Storage', kind: 'shared', parentId: 'runtime-boundary', realizedBy: 'worker', requiredCheckIds: ['health'] }],
  relations: [...f.input.relations, { id: 'tools-before-storage', from: 'tools', to: 'session', kind: 'order' }],
 }, f.deployment, f.graph);
 const result = await new AgentComponentsWorkflow({ ...f.options, definition }).start(); assert.equal(result.status, 'failed');
 const storage = projectAgentComponents(definition, result).boundaries.find(value => value.id === 'storage-boundary')!;
 assert.equal(result.components.find(value => value.id === 'session')?.status, 'skipped'); assert.equal(storage.observed, true);
 assert.deepEqual(storage.progress, { completed: 4, total: 8, indeterminate: false, unit: 'stages' });
 assert.equal(storage.status, 'skipped');
});

test('an accepted Create followed by an acquire exception is uncertain and cannot authorize another attempt', async t => {
 const f = await fixture(t, { human: true }); let accepted = 0;
 f.components.session!.adapters.create = async () => { accepted++; throw Error('Private provider accepted Create before transport failed'); };
 const workflow = f.workflow(), result = await workflow.start();
 assert.equal(result.status, 'incomplete'); assert.equal(result.ready, false); assert.equal(accepted, 1);
 const session = result.components.find(value => value.id === 'session')!;
 assert.equal(session.status, 'incomplete'); assert.equal(session.readiness?.flow.status, 'failed'); assert.equal(session.readiness?.flow.failure?.stageId, 'acquire');
 const reopened = await f.workflow().snapshot(); assert.equal(reopened.status, 'incomplete'); assert.equal(reopened.components.find(value => value.id === 'session')?.status, 'incomplete');
 await assert.rejects(f.workflow().start(), /already started/); assert.equal(accepted, 1);
});

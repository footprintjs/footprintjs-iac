import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { loadEvidence, replay, backwalk } from '../src/evidence.ts';
import { fingerprint } from '../src/util.ts';
import { readConnectionDetails, readResourceFlowState, ResourceFlowAdapterError, type ResourceFlowDefinition, type ResourceHandle, type ResourceFlowAdapters } from '../src/resource-flow/index.ts';
import { FileResourceFlowStore, ResourceFlowWorkflow } from '../src/resource-flow/node.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, mode: 'create' | 'existing' = 'create', human = false) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-resource-flow-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const definition: ResourceFlowDefinition = { id: 'history-connection-workflow', resourceId: 'history', label: 'History storage', mode,
    target: { id: 'local-owned-target', scope: 'fixed-cluster-and-namespace' }, configurationDigest: 'a'.repeat(64) };
  const handle: ResourceHandle = { id: 'history', kind: 'database', physicalId: 'server/database-42', scope: definition.target.scope };
  const controls = { exists: mode === 'existing', human, identity: handle.physicalId, verify: true, secretFailure: false };
  const calls: { stage: string; operationId: string; profile?: string }[] = [];
  const privatePassword = 'PASSWORD-MUST-NEVER-BE-RECORDED';
  const adapters: ResourceFlowAdapters = {
    async create(context) { calls.push({ stage: 'create', operationId: context.operationId }); controls.exists = true; return { ...handle, receipt: { id: 'native-create', runId: 'owned-create-run' } }; },
    async find(context) { calls.push({ stage: 'find', operationId: context.operationId }); if (!controls.exists) throw Error('External resource absent: ' + privatePassword); return { ...handle, physicalId: controls.identity }; },
    async validate(resource) { assert.equal(resource.scope, definition.target.scope); },
    async resolveDetails(resource, profileId, context) {
      calls.push({ stage: 'details', operationId: context.operationId, ...(profileId ? { profile: profileId } : {}) });
      if (controls.human && !profileId) return;
      return { profileId: 'company-history', resourceId: resource.id, endpoint: 'postgresql://office-db.internal:5432/history', protocol: 'postgresql', credentialRef: 'private-database-secret', trustRef: 'company-ca' };
    },
    async connect(resource, details, context) {
      calls.push({ stage: 'connect', operationId: context.operationId }); assert.ok(privatePassword);
      assert.equal(details.resourceId, resource.id); if (controls.secretFailure) throw Error('postgres://user:' + privatePassword + '@office-db');
      return { id: 'configure-app', runId: 'consumer-deployment-run', evidencePath: '/private/configuration-run.json' };
    },
    async verify(_resource, _details, _connection, context) { calls.push({ stage: 'verify', operationId: context.operationId });
      return { ok: controls.verify, checks: [{ id: 'app-database-access', passed: controls.verify }], receipts: [{ id: 'native-probe', runId: 'probe-run' }] }; },
  };
  const store = new FileResourceFlowStore(directory), profiles = [{ id: 'company-history', label: 'Company history database' }];
  const workflow = (changed: Partial<ResourceFlowDefinition> = {}) => new ResourceFlowWorkflow({ definition: { ...definition, ...changed }, store, profiles, adapters });
  return { directory, store, definition, controls, calls, adapters, workflow, privatePassword };
}

test('create, automatic details, connect and verify are four actual native stages with replayable evidence', async t => {
  const f = await fixture(t); const observed: string[] = [];
  const workflow = f.workflow(); workflow.subscribe(state => { observed.push(state.status + ':' + state.stages.find(stage => stage.status === 'running')?.id); });
  const state = await workflow.start();
  assert.equal(state.status, 'passed'); assert.equal(f.calls.filter(call => call.stage === 'create').length, 1);
  assert.deepEqual(state.events.map(event => [event.stageId, event.status]), [
    ['acquire', 'running'], ['acquire', 'passed'], ['details', 'running'], ['details', 'passed'],
    ['connect', 'running'], ['connect', 'passed'], ['verify', 'running'], ['verify', 'passed'],
  ]);
  assert.ok(observed.includes('running:connect')); assert.ok(state.stages.every(stage => stage.status === 'passed'));
  assert.equal(state.resource?.receipt?.runId, 'owned-create-run'); assert.equal(state.connection?.runId, 'consumer-deployment-run');
  assert.equal(state.verification?.receipts?.[0]?.runId, 'probe-run'); assert.equal(state.segments.length, 1);
  const segment = state.segments[0]!, evidence = await loadEvidence(segment.evidencePath);
  assert.equal(evidence.runId, segment.runId); assert.deepEqual(replay(evidence).state, evidence.snapshot.sharedState);
  const recorded = readStoredRecord(readRecordFile(segment.tracePath).entries).root(segment.runId);
  assert.ok(recorded?.complete); assert.deepEqual(recorded.gaps, []);
  assert.deepEqual(stateAt(recorded, recorded.commitLog.length - 1).state, evidence.snapshot.sharedState);
  assert.match(backwalk(evidence, 'connection').text, /resource|details/);
  assert.equal(JSON.stringify(evidence).includes(f.privatePassword), false);
  await assert.rejects(() => workflow.start(), /already started/);
});

test('existing resources are read-only acquisitions and a missing reference never falls back to create', async t => {
  const f = await fixture(t, 'existing'); const state = await f.workflow().start();
  assert.equal(state.status, 'passed'); assert.equal(state.stages[0]?.label, 'Find existing resource');
  assert.equal(f.calls.some(call => call.stage === 'create'), false);
  const missing = await fixture(t, 'existing'); missing.controls.exists = false;
  const failed = await missing.workflow().start();
  assert.equal(failed.status, 'failed'); assert.equal(failed.stages[0]?.status, 'failed');
  assert.equal(missing.calls.some(call => call.stage === 'create' || call.stage === 'connect'), false);
  const evidence = await readFile(failed.segments[0]!.evidencePath, 'utf8');
  assert.equal(evidence.includes(missing.privatePassword), false);
});

test('a native human interrupt persists without locks, resumes on a fresh workflow and never repeats create', async t => {
  const f = await fixture(t, 'create', true), initial = await f.workflow().start();
  assert.equal(initial.status, 'paused'); assert.ok(initial.pause); assert.equal(initial.stages[0]?.status, 'passed');
  assert.deepEqual(initial.stages.slice(2).map(stage => stage.status), ['pending', 'pending']);
  await f.store.withLock(async () => { assert.equal((await f.store.load())!.state.status, 'paused'); });
  await assert.rejects(() => f.workflow().resume({ pauseToken: '0'.repeat(64), profileId: 'company-history' }), /stale/);
  await assert.rejects(() => f.workflow().resume({ pauseToken: initial.pause!.token, profileId: 'not-configured' }), /stale/);
  const resumed = await f.workflow().resume({ pauseToken: initial.pause.token, profileId: 'company-history' });
  assert.equal(resumed.status, 'passed'); assert.equal(resumed.executionId, initial.executionId);
  assert.equal(f.calls.filter(call => call.stage === 'create').length, 1);
  assert.equal(f.calls.filter(call => call.stage === 'connect').length, 1);
  assert.equal(resumed.segments.length, 2); assert.notEqual(resumed.segments[0]?.runId, resumed.segments[1]?.runId);
  assert.equal(resumed.segments[1]?.resumedFromRunId, resumed.segments[0]?.runId);
  assert.ok(resumed.events.filter(event => event.stageId === 'details').every(event => event.runtimeStageId.startsWith('details#')));
  const evidence = await loadEvidence(resumed.segments[1]!.evidencePath);
  assert.equal((evidence.snapshot as { runId?: string }).runId, resumed.segments[1]?.runId);
  assert.ok(JSON.stringify(evidence).includes(resumed.segments[0]!.runId));
  assert.equal(JSON.stringify(await f.store.load()).includes(f.privatePassword), false);
  await assert.rejects(() => f.workflow().resume({ pauseToken: initial.pause!.token, profileId: 'company-history' }), /stale/);
});

test('resume refuses a changed configuration or resource identity before any connection effect', async t => {
  const f = await fixture(t, 'existing', true), paused = await f.workflow().start();
  await assert.rejects(() => f.workflow({ configurationDigest: 'b'.repeat(64) }).resume({ pauseToken: paused.pause!.token, profileId: 'company-history' }), /changed/);
  assert.equal(f.calls.some(call => call.stage === 'connect'), false);
  f.controls.identity = 'different-server/database-42';
  const result = await f.workflow().resume({ pauseToken: paused.pause!.token, profileId: 'company-history' });
  assert.equal(result.status, 'failed'); assert.equal(result.stages[1]?.status, 'failed');
  assert.equal(f.calls.some(call => call.stage === 'connect' || call.stage === 'create'), false);
});

test('tampered checkpoint and impossible public summaries are refused before effects', async t => {
  const f = await fixture(t, 'create', true), paused = await f.workflow().start(), envelope = (await f.store.load())!;
  envelope.checkpoint!.sharedState.connection = { id: 'injected', evidencePath: '/wrong' };
  envelope.checkpointDigest = fingerprint(envelope.checkpoint);
  await f.store.save(envelope);
  await assert.rejects(() => f.workflow().resume({ pauseToken: paused.pause!.token, profileId: 'company-history' }), /checkpoint/);
  assert.equal(f.calls.filter(call => call.stage === 'create').length, 1); assert.equal(f.calls.some(call => call.stage === 'connect'), false);
  assert.throws(() => readResourceFlowState({ ...paused, status: 'passed', pause: undefined }), /JSON|Unsupported/);
  const altered = structuredClone(paused); altered.stages[0]!.status = 'pending';
  assert.throws(() => readResourceFlowState(altered), /Unsupported/);
  assert.throws(() => readConnectionDetails({ profileId: 'company-history', resourceId: 'history', endpoint: 'postgresql://user:password@server/db', protocol: 'postgresql' }), /Unsupported/);
});

test('connect exceptions and negative measured verification retain failed native evidence without exposing secrets', async t => {
  const f = await fixture(t); f.controls.secretFailure = true;
  const failed = await f.workflow().start(); assert.equal(failed.status, 'failed'); assert.equal(failed.stages[2]?.status, 'failed');
  assert.equal(f.calls.some(call => call.stage === 'verify'), false);
  for (const file of [failed.segments[0]!.evidencePath, failed.segments[0]!.tracePath, f.store.path]) {
    assert.equal((await readFile(file, 'utf8')).includes(f.privatePassword), false);
  }
  const denied = await fixture(t); denied.controls.verify = false;
  const result = await denied.workflow().start();
  assert.equal(result.status, 'failed'); assert.equal(result.stages[3]?.status, 'failed');
  assert.equal(result.verification?.ok, false); assert.equal(result.verification?.checks[0]?.passed, false);
});

test('a fresh Node process resumes the exact native checkpoint with a stable physical resource and no second create', async t => {
  const f = await fixture(t, 'create', true), file = join(f.directory, 'physical-resource.json');
  const create = f.adapters.create!;
  f.adapters.create = async context => { const handle = await create(context); await writeFile(file, JSON.stringify({ handle, creates: 1 })); return handle; };
  const paused = await f.workflow().start(); assert.equal(paused.status, 'paused');
  const source = String.raw`
    import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const {ResourceFlowWorkflow,FileResourceFlowStore}=await import(process.argv[2]);
    const directory=process.argv[1],store=new FileResourceFlowStore(directory),saved=await store.load();
    const {id,resourceId,label,mode,target,configurationDigest}=saved.state;
    const workflow=new ResourceFlowWorkflow({definition:{id,resourceId,label,mode,target,configurationDigest},store,
      profiles:[{id:'company-history',label:'Company history database'}],adapters:{
        async create(){throw Error('A completed create must never execute in the resumed process');},
        async find(){return JSON.parse(await readFile(join(directory,'physical-resource.json'),'utf8')).handle;},
        async validate(){},
        async resolveDetails(resource,profileId){if(!profileId)return;return{profileId,resourceId:resource.id,endpoint:'postgresql://office-db.internal:5432/history',protocol:'postgresql',credentialRef:'private-database-secret',trustRef:'company-ca'};},
        async connect(resource,details,context){await writeFile(join(directory,'connected.json'),JSON.stringify({physicalId:resource.physicalId,profileId:details.profileId,operationId:context.operationId}));return{id:'child-connect'};},
        async verify(){return{ok:true,checks:[{id:'real-file-fixture',passed:true}]};}
      }});
    console.log(JSON.stringify(await workflow.resume({pauseToken:saved.state.pause.token,profileId:'company-history'})));
  `;
  const resumed = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.directory, new URL('../src/resource-flow/node.ts', import.meta.url).href], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(resumed.status, 0, resumed.stderr); const result = JSON.parse(resumed.stdout);
  assert.equal(result.status, 'passed'); assert.equal(result.executionId, paused.executionId);
  assert.equal(result.segments[1].resumedFromRunId, paused.segments[0]!.runId);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).creates, 1);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'connected.json'), 'utf8')).physicalId, paused.resource!.physicalId);
});

test('safe adapter failures retain native child receipts and code without a raw error or credential payload', async t => {
  const f = await fixture(t);
  const receipt = { id: 'failed-child-apply', runId: 'native-failed-connect-run', evidencePath: '/private/child-failure.json' };
  f.adapters.connect = async () => { throw new ResourceFlowAdapterError('native-connect-failed', receipt); };
  const result = await f.workflow().start();
  assert.equal(result.status, 'failed'); assert.deepEqual(result.failure, { stageId: 'connect', code: 'native-connect-failed', receipt });
  const evidence = await loadEvidence(result.segments[0]!.evidencePath);
  assert.deepEqual(evidence.snapshot.sharedState.failure, result.failure);
  assert.equal(JSON.stringify(evidence).includes(f.privatePassword), false);
  assert.throws(() => new ResourceFlowAdapterError('unsafe code with credentials'), /identifier/);
});

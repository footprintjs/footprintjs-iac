import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprint } from '../src/util.ts';
import type { ConnectionProfileChoice, ResourceFlowAdapters, ResourceFlowContext } from '../src/resource-flow/index.ts';
import { FileResourceFlowStore, ResourceFlowWorkflow } from '../src/resource-flow/node.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-profile-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const choices: ConnectionProfileChoice[] = [];
  const calls: { stage: string; context: ResourceFlowContext }[] = [];
  const resource = { id: 'existing-directory', kind: 'identity', physicalId: 'company/directory-17', scope: 'company-test' };
  const store = new FileResourceFlowStore(directory);
  const adapters: ResourceFlowAdapters = {
    async find(context) { calls.push({ stage: 'find', context }); assert.equal(context.profileId, 'company-primary-v1'); return resource; },
    async resolveDetails(handle, answered, context) {
      calls.push({ stage: 'details', context });
      if (!answered) return;
      return { profileId: answered, resourceId: handle.id, endpoint: 'https://identity.company.test', protocol: 'oidc', credentialRef: 'encrypted-secret-reference' };
    },
    async validate(_resource, _details, context) { calls.push({ stage: 'validate', context }); },
    async connect(_resource, details, context) {
      assert.equal(details.profileId, context.profileId); calls.push({ stage: 'connect', context }); return { id: 'configure-consumer' };
    },
    async verify(_resource, _details, _connection, context) { calls.push({ stage: 'verify', context }); return { ok: true, checks: [{ id: 'consumer-access', passed: true }] }; },
  };
  const create = (catalogId = 'company-connections') => new ResourceFlowWorkflow({
    definition: { id: 'company-existing-flow', resourceId: resource.id, label: 'Use existing identity', mode: 'existing',
      target: { id: 'company', scope: resource.scope }, configurationDigest: 'b'.repeat(64) },
    store, profiles: async () => choices, profileCatalogId: catalogId, requireProfileAtStart: true, adapters,
  });
  return { choices, calls, store, create, adapters };
}

test('user registration precedes Find, and the exact immutable selection survives a human pause and host restart', async t => {
  const f = await fixture(t), workflow = f.create();
  assert.equal((await workflow.snapshot()).status, 'idle');
  assert.equal(workflow.requiresProfileAtStart, true);
  await assert.rejects(() => workflow.start(), /Select a saved/);
  await assert.rejects(() => workflow.start({ profileId: 'not-registered' }), /unavailable/);
  await assert.rejects(() => workflow.start({ profileId: 'company-primary-v1', password: 'must-not-accept' } as never), /Unsupported/);
  assert.equal(f.calls.length, 0); assert.equal((await workflow.snapshot()).executionId, null);
  f.choices.push({ id: 'company-primary-v1', label: 'Company identity' }, { id: 'company-other-v1', label: 'Another identity' });
  const paused = await workflow.start({ profileId: 'company-primary-v1' });
  assert.equal(paused.status, 'paused'); assert.equal(paused.selectedProfileId, 'company-primary-v1');
  assert.deepEqual(paused.pause!.profiles.map(profile => profile.id), ['company-primary-v1']);
  assert.equal(f.calls.some(call => call.stage === 'connect'), false);
  await assert.rejects(() => workflow.resume({ pauseToken: paused.pause!.token, profileId: 'company-other-v1' }), /stale/);
  f.choices.push({ id: 'company-primary-v2', label: 'A new immutable revision' });
  const restarted = f.create();
  assert.equal((await restarted.snapshot()).definitionDigest, paused.definitionDigest);
  const complete = await restarted.resume({ pauseToken: paused.pause!.token, profileId: 'company-primary-v1' });
  assert.equal(complete.status, 'passed'); assert.equal(complete.executionId, paused.executionId);
  assert.equal(complete.segments.length, 2); assert.equal(complete.segments[1]!.resumedFromRunId, complete.segments[0]!.runId);
  assert.ok(f.calls.every(call => call.context.profileId === 'company-primary-v1'));
  assert.equal(f.calls.filter(call => call.stage === 'connect').length, 1);
  const evidence = JSON.parse(await readFile(complete.segments[1]!.evidencePath, 'utf8'));
  assert.equal(evidence.snapshot.sharedState.context.profileId, 'company-primary-v1');
  assert.equal(evidence.snapshot.sharedState.details.profileId, 'company-primary-v1');
});

test('removed selections, changed catalog identity and altered checkpoint profile are refused before Connect', async t => {
  const f = await fixture(t);
  f.choices.push({ id: 'company-primary-v1', label: 'Company identity' });
  const paused = await f.create().start({ profileId: 'company-primary-v1' });
  await assert.rejects(() => f.create('another-catalog').snapshot(), /changed/);
  const removed = f.choices.pop()!;
  await assert.rejects(() => f.create().resume({ pauseToken: paused.pause!.token, profileId: removed.id }), /changed/);
  f.choices.push(removed);
  const envelope = (await f.store.load())!;
  (envelope.checkpoint!.sharedState.context as ResourceFlowContext).profileId = 'company-other-v1';
  envelope.checkpointDigest = fingerprint(envelope.checkpoint);
  await f.store.save(envelope);
  await assert.rejects(() => f.create().resume({ pauseToken: paused.pause!.token, profileId: removed.id }), /checkpoint/);
  assert.equal(f.calls.some(call => call.stage === 'connect'), false);
});

test('automatic details cannot silently bind an application to another profile after Find', async t => {
  const f = await fixture(t); f.choices.push({ id: 'company-primary-v1', label: 'Company identity' }, { id: 'company-other-v1', label: 'Other identity' });
  f.adapters.resolveDetails = async handle => ({ profileId: 'company-other-v1', resourceId: handle.id,
    endpoint: 'https://identity.company.test', protocol: 'oidc' });
  const state = await f.create().start({ profileId: 'company-primary-v1' });
  assert.equal(state.status, 'failed'); assert.equal(state.failure?.stageId, 'details');
  assert.equal(f.calls.some(call => call.stage === 'connect'), false);
});

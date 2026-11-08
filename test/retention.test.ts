import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { InfraEngine, type ApplyResult } from '../src/engine.ts';
import { buildPlan } from '../src/planner.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { FileStateStore } from '../src/store.ts';
import { infra } from '../src/graph/builder.ts';
import { validateInfraGraph } from '../src/graph/validation.ts';
import { fingerprint, operationId } from '../src/util.ts';
import type { Resource, Stack, StackState } from '../src/types.ts';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const resource = (id: string, dependsOn: string[] = [], retainOnRemoval?: boolean): Resource => ({
  id, provider: 'simulator', spec: { value: id }, ...(dependsOn.length ? { dependsOn } : {}),
  ...(retainOnRemoval === undefined ? {} : { lifecycle: { retainOnRemoval } }),
});
const stack = (): Stack => ({ name: 'retained', resources: [
  resource('network'), resource('store', ['network'], true), resource('app', ['store', 'temporary']), resource('temporary', ['network']),
] });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const providerFile = join(directory, 'provider.json');
  const adapter = new SimulatorAdapter({ file: providerFile });
  const store = new FileStateStore(join(directory, 'state'));
  const engine = new InfraEngine({ adapters: [adapter], store, maxConcurrency: 2 });
  return { directory, providerFile, adapter, store, engine };
}

test('explicit prune retains an omitted resource and its saved dependency closure while deleting unrelated work in reverse order', async t => {
  const { adapter, store, engine } = await fixture(t);
  assert.equal((await engine.apply(stack())).ok, true);
  adapter.calls.length = 0;
  const result = await engine.apply({ name: 'retained', resources: [] }, { prune: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.retained, [
    { resourceId: 'network', reason: 'dependency' }, { resourceId: 'store', reason: 'retention-policy' },
  ]);
  assert.deepEqual(adapter.calls.map(call => `${call.action}:${call.id}`), ['delete:app', 'delete:temporary']);
  const saved = await store.load('retained');
  assert.deepEqual(Object.keys(saved.resources).sort(), ['network', 'store']);
  assert.deepEqual(saved.resources.store!.resource.lifecycle, { retainOnRemoval: true });
  assert.equal((await adapter.observe(resource('store'), { stack: 'retained', operationId: 'inspect' })).exists, true);
});

test('omitting a saved flag cannot clear retention and explicit false releases it without a provider mutation', async t => {
  const { adapter, store, engine } = await fixture(t);
  const original: Stack = { name: 'retained', resources: [resource('network'), resource('store', ['network'], true)] };
  assert.equal((await engine.apply(original)).ok, true);
  adapter.calls.length = 0;
  for (const lifecycle of [undefined, {}]) {
    const storeResource = resource('store', ['network']);
    if (lifecycle) storeResource.lifecycle = lifecycle;
    const result = await engine.apply({ name: 'retained', resources: [resource('network'), storeResource] });
    assert.equal(result.ok, true);
    assert.ok(result.plan.operations.every(operation => operation.action === 'noop'));
    assert.deepEqual((await store.load('retained')).resources.store!.resource.lifecycle, { retainOnRemoval: true });
  }
  const released = resource('store', ['network'], false);
  const clear = await engine.apply({ name: 'retained', resources: [resource('network'), released] });
  assert.equal(clear.ok, true);
  assert.ok(clear.plan.operations.every(operation => operation.action === 'noop'));
  assert.equal(adapter.calls.length, 0, 'policy changes are local metadata, outside the provider spec');
  assert.deepEqual((await store.load('retained')).resources.store!.resource.lifecycle, { retainOnRemoval: false });
  assert.equal(operationId('retained', original.resources[1]!, 'apply'), operationId('retained', released, 'apply'));
  const pruned = await engine.apply({ name: 'retained', resources: [] }, { prune: true });
  assert.equal(pruned.plan.retained, undefined);
  assert.deepEqual(adapter.calls.map(call => call.id), ['store', 'network']);
  assert.deepEqual((await store.load('retained')).resources, {});
});

test('retention survives a fresh store and provider instance and does not prevent explicit desired updates', async t => {
  const { providerFile, store, engine } = await fixture(t);
  assert.equal((await engine.apply(stack())).ok, true);
  const adapter = new SimulatorAdapter({ file: providerFile });
  const restartedStore = new FileStateStore(store.directory);
  const restarted = new InfraEngine({ adapters: [adapter], store: restartedStore });
  const changed = resource('store', ['network']); changed.spec.value = 'updated';
  const update = await restarted.apply({ name: 'retained', resources: [resource('network'), changed] });
  assert.equal(update.ok, true);
  assert.deepEqual(adapter.calls.map(call => `${call.action}:${call.id}`), ['apply:store']);
  assert.deepEqual((await restartedStore.load('retained')).resources.store!.resource.lifecycle, { retainOnRemoval: true });
  adapter.calls.length = 0;
  const result = await restarted.apply({ name: 'retained', resources: [] }, { prune: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.retained?.map(row => row.resourceId), ['network', 'store']);
  assert.deepEqual(adapter.calls.map(call => call.id), ['app', 'temporary']);
});

test('retained dependency protection is transitive and uses saved edges even when desired dependencies change', async t => {
  const { engine, store } = await fixture(t);
  const saved: Stack = { name: 'retained', resources: [resource('physical'), resource('network', ['physical']), resource('store', ['network'], true)] };
  assert.equal((await engine.apply(saved)).ok, true);
  const plan = await engine.plan({ name: 'retained', resources: [resource('network')] }, { prune: true });
  assert.deepEqual(plan.retained, [
    { resourceId: 'network', reason: 'dependency' }, { resourceId: 'physical', reason: 'dependency' }, { resourceId: 'store', reason: 'retention-policy' },
  ]);
  assert.equal(plan.operations.some(operation => operation.action === 'delete'), false);
  assert.deepEqual((await store.load('retained')).resources.network!.resource.dependsOn, ['physical'], 'planning must not alter saved topology');
});

test('graph lifecycle metadata round trips, affects the digest, and boundary moves do not change provider fingerprints', async t => {
  const { adapter, engine, store } = await fixture(t);
  function graph(boundaryId: string) {
    return infra('retained').start(resource('store', [], true)).boundary({ id: boundaryId, kind: 'group' })
      .within(boundaryId, 'store').synth();
  }
  const first = graph('data');
  assert.deepEqual(first.resources[0]!.lifecycle, { retainOnRemoval: true });
  assert.deepEqual(validateInfraGraph(JSON.parse(JSON.stringify(first))), first);
  const tampered = JSON.parse(JSON.stringify(first)) as typeof first;
  tampered.resources[0]!.lifecycle!.retainOnRemoval = false;
  assert.throws(() => validateInfraGraph(tampered), /digest mismatch/);
  const unretained = infra('retained').start(resource('store', [], false)).boundary({ id: 'data', kind: 'group' }).within('data', 'store').synth();
  assert.notEqual(first.digest, unretained.digest);
  assert.equal((await engine.apply(first)).ok, true);
  adapter.calls.length = 0;
  const moved = graph('archive');
  assert.notEqual(first.digest, moved.digest);
  const result = await engine.apply(moved);
  assert.equal(result.ok, true);
  assert.equal(result.plan.operations[0]!.action, 'noop');
  assert.equal(adapter.calls.length, 0);
  assert.equal(result.plan.operations[0]!.desiredFingerprint, fingerprint(first.resources[0]!.spec));
  assert.deepEqual((await store.load('retained')).resources.store!.resource.lifecycle, { retainOnRemoval: true });
});

test('invalid lifecycle fields fail before provider observations in plain stacks, graphs, and saved state', async t => {
  const { store } = await fixture(t);
  let observations = 0;
  const adapter = new SimulatorAdapter();
  const observe = adapter.observe.bind(adapter);
  adapter.observe = async (...args) => { observations++; return observe(...args); };
  const adapters = new Map([[adapter.name, adapter]]);
  const empty: StackState = { version: 1, stack: 'retained', resources: {} };
  await store.save(empty);
  for (const lifecycle of [null, [], true, 'true', { retainOnRemoval: 'true' }, { retainOnRemoval: undefined }, { retain: true }, { retainOnRemoval: true, extra: false }]) {
    const bad = { ...resource('bad'), lifecycle } as unknown as Resource;
    await assert.rejects(() => buildPlan({ name: 'retained', resources: [resource('good'), bad] }, empty, adapters), /lifecycle/);
    assert.throws(() => infra('retained').start(bad).synth(), /lifecycle|JSON/);
    const state: StackState = { version: 1, stack: 'retained', resources: { bad: { resource: bad, fingerprint: 'saved' } } };
    await assert.rejects(() => store.save(state), /lifecycle/);
    await writeFile(store.statePath('retained'), JSON.stringify(state));
    // JSON drops undefined; every other malformed policy must also fail persisted admission.
    if (!(lifecycle && typeof lifecycle === 'object' && 'retainOnRemoval' in lifecycle && lifecycle.retainOnRemoval === undefined)) {
      await assert.rejects(() => store.load('retained'), /lifecycle/);
    }
    await assert.rejects(() => buildPlan({ name: 'retained', resources: [resource('good')] }, state, adapters), /lifecycle/);
  }
  let getterCalls = 0;
  const lifecycle = Object.defineProperty({}, 'retainOnRemoval', { enumerable: true, get() { getterCalls++; return true; } });
  await assert.rejects(() => buildPlan({ name: 'retained', resources: [{ ...resource('bad'), lifecycle }] }, empty, adapters), /lifecycle/);
  assert.equal(getterCalls, 0);
  assert.equal(observations, 0);
});

test('CLI destroy retains storage and its dependencies while deleting the application', async t => {
  const { directory } = await fixture(t);
  const stackPath = join(directory, 'stack.json');
  const stateDirectory = join(directory, 'cli-state');
  await writeFile(stackPath, JSON.stringify(stack()));
  async function run(command: string): Promise<ApplyResult> {
    const result = await execute(process.execPath, [cli, command, stackPath, '--state-dir', stateDirectory], {
      cwd: directory, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: '', HTTP_PROXY: '', HTTPS_PROXY: '' },
    });
    return JSON.parse(result.stdout) as ApplyResult;
  }
  assert.equal((await run('apply')).ok, true);
  const destroyed = await run('destroy');
  assert.equal(destroyed.ok, true);
  assert.deepEqual(destroyed.plan.retained, [
    { resourceId: 'network', reason: 'dependency' }, { resourceId: 'store', reason: 'retention-policy' },
  ]);
  assert.deepEqual(destroyed.plan.operations.map(operation => operation.resource.id), ['app', 'temporary']);
  const saved = await new FileStateStore(stateDirectory).load('retained');
  assert.deepEqual(Object.keys(saved.resources).sort(), ['network', 'store']);
  const provider = JSON.parse(await readFile(join(stateDirectory, 'simulator-provider.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(provider).sort(), ['network', 'store']);
});


test('a failed desired update cannot release saved retention before convergence', async t => {
  const { adapter, store, engine } = await fixture(t);
  const original: Stack = { name: 'retained', resources: [resource('network'), resource('store', ['network'], true)] };
  assert.equal((await engine.apply(original)).ok, true);
  adapter.faults.failBeforeApply = new Set(['store']);
  const changed = resource('store', ['network'], false);
  changed.spec.value = 'failed-update';
  const failed = await engine.apply({ name: 'retained', resources: [resource('network'), changed] });
  assert.equal(failed.ok, false);
  const saved = await store.load('retained');
  assert.equal(saved.resources.store!.pending?.action, 'update');
  assert.deepEqual(saved.resources.store!.resource.lifecycle, { retainOnRemoval: true });
  adapter.calls.length = 0;
  const prune = await engine.apply({ name: 'retained', resources: [] }, { prune: true });
  assert.equal(prune.ok, true);
  assert.deepEqual(prune.plan.retained, [
    { resourceId: 'network', reason: 'dependency' }, { resourceId: 'store', reason: 'retention-policy' },
  ]);
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(Object.keys((await store.load('retained')).resources).sort(), ['network', 'store']);
});

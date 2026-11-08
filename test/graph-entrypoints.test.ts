import assert from 'node:assert/strict';
import test from 'node:test';
import { InfraEngine, buildPlan, infra, resource } from '../src/index.ts';
import type { ResourceAdapter, Stack, StateStore } from '../src/types.ts';

function accessorGraphFixture() {
  const base = infra('accessor-entrypoint').start(resource('app', 'simulator', { replicas: 1 })).synth();
  const input = JSON.parse(JSON.stringify(base));
  const calls = { getter: 0, store: 0, provider: 0 };
  Object.defineProperty(input.resources[0], 'spec', {
    enumerable: true, configurable: true,
    get() { calls.getter++; return base.resources[0]!.spec; },
  });
  const store: StateStore = {
    async load() { calls.store++; throw new Error('Unexpected state load'); },
    async save() { calls.store++; throw new Error('Unexpected state save'); },
    async append() { calls.store++; throw new Error('Unexpected journal append'); },
    async withLock(_stack, work) { calls.store++; return work(); },
    async saveEvidence() { calls.store++; throw new Error('Unexpected evidence save'); },
  };
  const adapter: ResourceAdapter = {
    name: 'simulator',
    async observe() { calls.provider++; throw new Error('Unexpected provider observation'); },
    async apply() { calls.provider++; throw new Error('Unexpected provider mutation'); },
    async remove() { calls.provider++; throw new Error('Unexpected provider deletion'); },
    async waitReady() { calls.provider++; throw new Error('Unexpected provider wait'); },
  };
  return { graph: input as Stack, calls, store, adapter };
}

test('public buildPlan rejects an accessor-bearing graph without invoking it or observing the provider', async () => {
  const { graph, calls, adapter } = accessorGraphFixture();
  await assert.rejects(() => buildPlan(graph,
    { version: 1, stack: graph.name, resources: {} },
    new Map([[adapter.name, adapter]])), /accessors/);
  assert.deepEqual(calls, { getter: 0, store: 0, provider: 0 });
});

for (const method of ['plan', 'apply'] as const) {
  test(`public engine.${method} admits graph JSON before cloning or invoking any accessor`, async () => {
    const { graph, calls, store, adapter } = accessorGraphFixture();
    const engine = new InfraEngine({ adapters: [adapter], store });
    await assert.rejects(() => engine[method](graph), /accessors/);
    assert.deepEqual(calls, { getter: 0, store: 0, provider: 0 });
  });
}

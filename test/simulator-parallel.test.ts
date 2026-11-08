import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import type { Resource } from '../src/types.ts';

const item = (id: number): Resource => ({ id: `r${id}`, provider: 'simulator', spec: { value: id } });
const context = { stack: 'parallel-store', operationId: 'test' };

test('parallel simulator transactions retain every disk-backed effect and later removal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-simulator-parallel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'provider.json');
  const adapter = new SimulatorAdapter({ file });
  const resources = Array.from({ length: 24 }, (_, index) => item(index));
  await Promise.all(resources.map(resource => adapter.apply(resource, context)));
  const restarted = new SimulatorAdapter({ file });
  assert.ok((await Promise.all(resources.map(resource => restarted.observe(resource, context)))).every(observed => observed.exists && observed.owned));
  await Promise.all(resources.map((resource, index) => index % 2 === 0
    ? adapter.remove(resource, context)
    : adapter.injectDrift(resource.id, { value: 100 + index })));
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, { spec: { value: number } }>;
  assert.equal(Object.keys(saved).length, 12);
  for (let index = 0; index < 24; index++) {
    if (index % 2 === 0) assert.equal(saved[`r${index}`], undefined);
    else assert.equal(saved[`r${index}`]?.spec.value, 100 + index);
  }
});

test('a delayed simulator response permits another committed provider effect', { timeout: 5000 }, async () => {
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = new SimulatorAdapter({ faults: { afterEffect: async () => { if (++entered === 2) release(); await gate; } } });
  await Promise.all([adapter.apply(item(1), context), adapter.apply(item(2), context)]);
  assert.equal(entered, 2);
});

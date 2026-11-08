import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import type { Stack } from '../src/types.ts';

test('a rejected field addition preserves the completed definition for a subsequent restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-iac-rejected-'));
  try {
    const adapter = new SimulatorAdapter();
    const store = new FileStateStore(directory);
    const engine = new InfraEngine({ adapters: [adapter], store });
    const original: Stack = { name: 'restore', resources: [{ id: 'config', provider: 'simulator', spec: { value: 1 } }] };
    assert.equal((await engine.apply(original)).ok, true);
    adapter.faults.failBeforeApply = new Set(['config']);
    const invalid = structuredClone(original);
    invalid.resources[0]!.spec.rejectedAddition = 'never applied';
    assert.equal((await engine.apply(invalid)).ok, false);
    assert.deepEqual((await store.load(original.name)).resources.config?.resource, original.resources[0]);
    assert.equal((await engine.plan(original)).operations[0]?.action, 'noop');
    assert.equal((await engine.apply(original)).ok, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

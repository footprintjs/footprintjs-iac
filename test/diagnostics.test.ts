import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { loadEvidence } from '../src/evidence.ts';
import { infra, resource } from '../src/graph/index.ts';
import { explainRun } from '../src/diagnostics/explain.ts';

test('agent explanation links a recorded failure to design boundaries without new provider work or causal overclaim', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const network = resource('network', 'simulator', { value: 1 });
  const app = resource('app', 'simulator', { value: 2 });
  const graph = infra('diagnostic').boundary({ id: 'restricted', kind: 'security' })
    .start(network).next(app).within('restricted', app).synth();
  const provider = new SimulatorAdapter({ faults: { failBeforeApply: new Set(['app']) } });
  const engine = new InfraEngine({ adapters: [provider], store: new FileStateStore(directory) });
  const result = await engine.apply(graph);
  assert.equal(result.ok, false);
  const evidence = await loadEvidence(result.evidencePath);
  const before = provider.calls.length;
  const explanation = explainRun(evidence);
  assert.equal(explanation.failure?.resourceId, 'app');
  assert.equal(explanation.design?.digest, graph.digest);
  assert.deepEqual(explanation.design?.boundaries, [{ id: 'restricted', kind: 'security', status: 'declared' }]);
  assert.ok(explanation.dependencies.writerId);
  assert.ok(Object.values(explanation.dependencies.nodes ?? {}).some(node => node.stageName === 'Reconcile app'));
  assert.equal(explanation.externalRootCause, 'not-established');
  assert.equal(provider.calls.length, before);
  assert.deepEqual(JSON.parse(JSON.stringify(explanation)), explanation);
  assert.deepEqual(explainRun(evidence), explanation, 'same recording/query produces the same structured result');
});

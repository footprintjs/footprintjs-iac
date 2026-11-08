import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { system, artifact, ref } from '../src/system/index.ts';
import { systemToMermaid, systemToSvg } from '../src/system/render.ts';
import { bindSystem, simulationProfile } from '../src/binding/index.ts';
import { InfraEngine } from '../src/engine.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { FileStateStore } from '../src/store.ts';
import { explainRun } from '../src/diagnostics/explain.ts';
import { loadEvidence, replay } from '../src/evidence.ts';
import type { Stack, StateStore } from '../src/types.ts';

function designFixture() {
  return system('capability-evidence')
    .addNetwork('network', network => network.addSegment('backend'))
    .addStorage('state', storage => storage.addSessionStore('sessions', sessions =>
      sessions.sharing('shared').durability('persistent').expiration({ idle: '30m' })))
    .addCompute('application', compute => compute.addService('api', service => service
      .program(artifact('api-program'))
      .useNetwork(ref.network('network.backend'))
      .useStorage(ref.store('state.sessions'), { access: 'readWrite' })))
    .build();
}

test('recorded resource failure resolves to original capability and simulated adapter without new provider calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-capability-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const design = designFixture();
  const binding = bindSystem(design, simulationProfile({ artifacts: { 'api-program': { executable: 'fixture-api' } } }));
  const resourceId = binding.mappings.find(mapping => mapping.capabilityId === 'api')!.resourceIds[0]!;
  const provider = new SimulatorAdapter({ faults: { failBeforeApply: new Set([resourceId]) } });
  const result = await new InfraEngine({ adapters: [provider], store: new FileStateStore(directory), maxConcurrency: 2 }).apply(binding.graph);
  assert.equal(result.ok, false);
  const evidence = await loadEvidence(result.evidencePath);
  const calls = provider.calls.length;
  const explanation = explainRun(evidence);
  const origin = explanation.design?.capabilities?.origins.find(item => item.capabilityId === 'api');
  assert.ok(origin);
  assert.equal(origin.designDigest, design.digest);
  assert.equal(origin.capabilityPath, 'application.api');
  assert.equal(origin.family, 'compute');
  assert.equal(origin.mode, 'simulation');
  assert.equal(origin.status, 'declared');
  assert.equal(explanation.externalRootCause, 'not-established');
  assert.ok(Object.values(explanation.dependencies.nodes ?? {}).some(node => node.stageName === `Reconcile ${resourceId}`));
  assert.deepEqual(replay(evidence).state, evidence.snapshot.sharedState);
  assert.equal(provider.calls.length, calls);
});

test('intent diagrams expose composition before adapter selection and reject changed definitions', () => {
  const design = designFixture();
  const diagram = systemToMermaid(design);
  assert.ok(diagram.includes(design.digest));
  for (const family of ['compute', 'storage', 'network']) assert.ok(diagram.includes(family));
  assert.ok(diagram.includes('application'));
  const svg = systemToSvg(design);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('api'));
  const changed = structuredClone(design);
  changed.capabilities[0]!.properties['extra-property'] = true;
  assert.throws(() => systemToMermaid(changed));
});

test('unbound systems cannot enter provider execution as if they were resource stacks', async () => {
  let touched = false;
  const unexpected = async () => { touched = true; throw new Error('Unexpected state access'); };
  const store: StateStore = { load: unexpected, save: unexpected, append: unexpected, saveEvidence: unexpected, withLock: unexpected };
  const engine = new InfraEngine({ adapters: [new SimulatorAdapter()], store });
  await assert.rejects(engine.apply(designFixture() as unknown as Stack));
  assert.equal(touched, false);
});

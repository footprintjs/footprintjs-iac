import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { system, artifact } from '../src/system/index.ts';
import { bindSystem, simulationProfile } from '../src/binding/index.ts';
import { InfraEngine, FileStateStore, SimulatorAdapter, loadEvidence, replay, backwalk, explainRun } from '../src/index.ts';
import { agentSystemRecipe } from './recipes/agent-system.ts';
import { overlapProbe } from './capabilities/overlap-probe.ts';
import { writeCapabilityViews, writeJson } from './capabilities/write-artifacts.ts';

export function createAgentDesign() {
  return system('capability-demo').use(agentSystemRecipe({ prefix: 'demo', program: artifact('agent-program') })).build();
}

async function main() {
  const root = resolve('.artifacts/capabilities');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'run-'));
  const design = createAgentDesign();
  const profile = (version: string) => simulationProfile({ artifacts: { 'agent-program': { executable: 'agent-fixture', version } } });
  const binding = bindSystem(design, profile('v1'));
  await writeCapabilityViews(directory, design, binding);
  assert.ok(binding.decisions.every(decision => decision.status === 'simulated'));
  const mapped = (id: string) => binding.mappings.find(mapping => mapping.capabilityId === id)!;
  const networkId = mapped('demo-backend').resourceIds[0]!;
  const serviceId = mapped('demo-agent').resourceIds[0]!;
  const probe = overlapProbe();
  const provider = new SimulatorAdapter({ file: join(directory, 'provider.json'), faults: {
    afterEffect: () => probe.afterEffect(), loseResponseAfterApply: new Set([networkId]),
  } });
  const store = new FileStateStore(join(directory, 'state'));
  const engine = new InfraEngine({ adapters: [provider], store, traceDirectory: join(directory, 'traces'), maxConcurrency: 2 });
  const created = await engine.apply(binding.graph);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal(probe.peak, 2);
  assert.equal(provider.calls.filter(call => call.action === 'apply' && call.id === networkId).length, 1);
  assert.ok((await engine.plan(binding.graph)).operations.every(operation => operation.action === 'noop'));

  const updated = bindSystem(design, profile('v2'));
  await writeJson(join(directory, 'updated-binding.json'), updated);
  provider.faults.failBeforeApply = new Set([serviceId]);
  const failed = await engine.apply(updated.graph);
  assert.equal(failed.ok, false);
  assert.equal(failed.failure?.resourceId, serviceId);
  const evidence = await loadEvidence(failed.evidencePath);
  const callsBeforeInspection = provider.calls.length;
  const inspection = explainRun(evidence);
  const origins = inspection.design?.capabilities?.origins ?? [];
  assert.ok(origins.some(origin => origin.capabilityId === 'demo-agent' && origin.designDigest === design.digest && origin.mode === 'simulation'));
  assert.deepEqual(replay(evidence).state, evidence.snapshot.sharedState);
  const slice = backwalk(evidence);
  assert.ok(slice.slice.root);
  assert.equal(provider.calls.length, callsBeforeInspection);
  await writeJson(join(directory, 'inspection.json'), inspection);
  await writeFile(join(directory, 'failure-backwalk.txt'), slice.text + '\n', { mode: 0o600 });
  provider.faults.failBeforeApply.clear();
  const repaired = await engine.apply(updated.graph);
  assert.equal(repaired.ok, true, repaired.failure?.message);
  assert.ok((await engine.plan(updated.graph)).operations.every(operation => operation.action === 'noop'));

  const cleanup = await engine.apply({ name: design.name, resources: [] }, { prune: true });
  assert.equal(cleanup.ok, true, cleanup.failure?.message);
  const retainedIds = cleanup.plan.retained?.map(entry => entry.resourceId).sort() ?? [];
  const historyIds = [...mapped('demo-history').resourceIds].sort();
  assert.deepEqual(retainedIds, historyIds);
  assert.deepEqual(Object.keys((await store.load(design.name)).resources).sort(), historyIds);
  assert.ok(provider.calls.some(call => call.action === 'delete' && call.id === serviceId));
  assert.ok(provider.calls.filter(call => call.action === 'delete').every(call => !historyIds.includes(call.id)));
  await writeJson(join(directory, 'retention-plan.json'), cleanup.plan);
  const report = {
    passed: true, scope: 'Explicit local simulation only; no live application, cloud, database, authorization or schedule guarantee.',
    directory, version: '0.3.0', designDigest: design.digest, initialBindingDigest: binding.digest,
    updatedBindingDigest: updated.digest, actualProviderConcurrency: probe.peak, lostResponseCreateSendCount: 1,
    failureRunId: failed.runId, failureEvidencePath: failed.evidencePath, failureTracePath: failed.tracePath,
    retainedResourceIds: retainedIds, wrapper: 'Ordinary agentic recipe composed over the public base API',
    checks: ['high-level-capabilities', 'visible-recipe-defaults', 'explicit-simulated-binding', 'expanded-resource-graph',
      'bounded-parallel-reconciliation', 'lost-response-single-send', 'unchanged-noop', 'failure-to-capability-origin',
      'read-only-replay-and-backwalk', 'repair-convergence', 'retained-storage-and-dependency-closure'],
  };
  await writeJson(join(directory, 'report.json'), report);
  await writeJson(join(root, 'latest-report.json'), report);
  console.log('PASS capability base → domain recipe → binding → recorded reconciliation → retention');
  console.log('Intent, expanded graph, decisions, diagnostics and report: ' + directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

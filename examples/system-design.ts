import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InfraEngine, FileStateStore, SimulatorAdapter, backwalk, loadEvidence, replay } from '../src/index.ts';
import { infra, readInfraGraph, resource, type InfraGraph } from '../src/graph/index.ts';
import { graphToMermaid } from '../src/graph/render.ts';
import { graphToSvg } from '../src/graph/svg.ts';

export function createSystemDesignGraph(image = 'demo:v1'): InfraGraph {
  const network = resource('demo-network', 'simulator', { kind: 'network', cidr: '10.42.0.0/24' });
  const database = resource('demo-database', 'simulator', { kind: 'database', engine: 'example-sql' });
  const cache = resource('demo-cache', 'simulator', { kind: 'cache', capacity: 'small' });
  const api = resource('demo-api', 'simulator', {
    kind: 'application', image,
    // Declared simulator inputs, not references to provider-generated outputs.
    database: 'demo-database', cache: 'demo-cache',
  });

  return infra('system-design-demo')
    .boundary({ id: 'local-region', kind: 'region', label: 'Local simulator region',
      attributes: { placementEnforcement: 'none' } })
    .boundary({ id: 'application-security', kind: 'security', label: 'Application review scope',
      attributes: { enforcement: 'descriptive-only', note: 'No firewall or authorization policy is synthesized.' } })
    .boundary({ id: 'data-security', kind: 'security', label: 'Data review scope',
      attributes: { enforcement: 'descriptive-only', note: 'A separate overlapping view, not an isolation guarantee.' } })
    .boundary({ id: 'local-host', kind: 'physical', label: 'Local simulator host' })
    .boundary({ id: 'application-owner', kind: 'ownership', label: 'Example application owner context',
      attributes: { identityVerification: 'none' } })
    .boundary({ id: 'runtime-role', kind: 'role', label: 'Application runtime' })
    .boundary({ id: 'data-role', kind: 'role', label: 'Data services' })
    .start(network)
    .parallel(database, cache)
    .next(api)
    .within('local-region', network, database, cache, api)
    .within('application-security', api, database, cache)
    .within('data-security', database, cache)
    .within('local-host', network, database, cache, api)
    .within('application-owner', network, database, cache, api)
    .within('runtime-role', api)
    .within('data-role', database, cache)
    .connect(api, database, 'communicatesWith', 'Declared SQL path')
    .connect(api, cache, 'communicatesWith', 'Declared cache path')
    .synth();
}

async function writeViews(directory: string, graph: InfraGraph): Promise<void> {
  await writeFile(join(directory, 'graph.json'), JSON.stringify(graph, null, 2) + '\n', { mode: 0o600 });
  const views = [
    ['deployment', { view: 'deployment' }],
    ['architecture', { view: 'architecture' }],
    ['security', { view: 'architecture', boundaryKind: 'security' }],
    ['region', { view: 'architecture', boundaryKind: 'region' }],
  ] as const;
  for (const [name, options] of views) {
    await writeFile(join(directory, name + '.mmd'), graphToMermaid(graph, options) + '\n', { mode: 0o600 });
    await writeFile(join(directory, name + '.svg'), graphToSvg(graph, options), { mode: 0o600 });
  }
}

function parallelProbe() {
  let active = 0, peak = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  return {
    get peak() { return peak; },
    async afterEffect(entry: { id: string }) {
      if (!['demo-database', 'demo-cache'].includes(entry.id)) return;
      active++;
      peak = Math.max(peak, active);
      if (active === 2) release();
      try {
        // A bounded barrier proves actual overlap without depending on short
        // timing differences in filesystem or provider scheduling.
        await new Promise<void>((accept, reject) => {
          const timer = setTimeout(() => reject(new Error('The declared parallel resources did not overlap.')), 3_000);
          void bothStarted.then(() => { clearTimeout(timer); accept(); });
        });
      } finally { active--; }
    },
  };
}

async function main(): Promise<void> {
  const artifacts = resolve('.artifacts/system-design');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(artifacts, 'run-'));
  const graph = createSystemDesignGraph();
  await writeViews(directory, graph);
  const probe = parallelProbe();
  const provider = new SimulatorAdapter({ faults: {
    loseResponseAfterApply: new Set(['demo-network']),
    afterEffect: entry => probe.afterEffect(entry),
  } });
  const engine = new InfraEngine({
    adapters: [provider], store: new FileStateStore(join(directory, 'state')),
    traceDirectory: join(directory, 'traces'), maxConcurrency: 2,
  });
  const created = await engine.apply(graph);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal(probe.peak, 2, 'The declared fork must actually execute two provider operations concurrently.');
  assert.equal(provider.calls.filter(call => call.action === 'apply' && call.id === 'demo-network').length, 1,
    'Reconciliation must not send the lost-response create twice.');
  const unchanged = await engine.plan(graph);
  assert.ok(unchanged.operations.every(operation => operation.action === 'noop'));

  const changed = createSystemDesignGraph('demo:v2');
  provider.faults.failBeforeApply = new Set(['demo-api']);
  const failed = await engine.apply(changed);
  assert.equal(failed.ok, false);
  assert.equal(failed.failure?.resourceId, 'demo-api');
  await writeFile(join(directory, 'failed-graph.json'), JSON.stringify(changed, null, 2) + '\n', { mode: 0o600 });
  const savedFailure = JSON.parse(await readFile(failed.evidencePath, 'utf8')) as { graph?: unknown };
  const recordedGraph = readInfraGraph(savedFailure.graph);
  assert.deepEqual(recordedGraph, changed, 'The failure recording must retain the exact validated graph that executed.');
  const evidence = await loadEvidence(failed.evidencePath);
  const explanation = backwalk(evidence, 'failure');
  assert.ok(explanation.slice.root);
  assert.match(explanation.text, /demo-api/);
  assert.deepEqual(replay(evidence).state, evidence.snapshot.sharedState);
  await writeFile(join(directory, 'failure-backwalk.txt'), explanation.text + '\n', { mode: 0o600 });

  provider.faults.failBeforeApply.clear();
  const repaired = await engine.apply(changed);
  assert.equal(repaired.ok, true, repaired.failure?.message);
  assert.ok((await engine.plan(changed)).operations.every(operation => operation.action === 'noop'));
  const report = {
    passed: true, scope: 'Local simulator only; no Kubernetes, cloud API, model or live collector calls.',
    directory, stack: graph.name, observedProviderConcurrency: probe.peak, maxConcurrency: 2,
    initialGraphDigest: graph.digest, failureGraphDigest: changed.digest, recordedFailureGraphDigest: recordedGraph.digest,
    lostResponseCreateSendCount: provider.calls.filter(call => call.action === 'apply' && call.id === 'demo-network').length,
    createdRun: created.runId, failureRun: failed.runId, repairedRun: repaired.runId,
    failureEvidencePath: failed.evidencePath, failureTracePath: failed.tracePath,
    checks: ['fluent-serial-fork-join', 'bounded-parallel-provider-work', 'lost-response-reconciliation',
      'unchanged-noop', 'failed-update-evidence', 'saved-graph-digest-binding', 'offline-replay-and-backwalk', 'repair-convergence'],
    boundarySemantics: 'Descriptive grouping only; no security, placement or ownership policy is inferred from names.',
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(artifacts, 'latest-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('PASS fluent graph, bounded parallel execution, failure investigation and repair');
  console.log('Graph JSON, Mermaid, SVG and evidence: ' + directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindSystem, InfraEngine, FileStateStore, KubernetesAdapter, graphToMermaid, systemToMermaid } from '../../src/index.ts';
import { createNeoSystem } from './system.ts';
import { neoKubernetesProfile } from './kubernetes-profile.ts';
import { NEO_NAMESPACE } from './stack.ts';
import { smoke } from './smoke.mjs';
import { probeDeployment } from './review/probe.ts';
import { startReviewForward } from './review/forward.ts';
import { REVIEW_CONTEXT, reviewTarget } from './setup/target.ts';
import { readReviewImages } from './setup/images.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export async function runNeoReview(context: string) {
  const target = reviewTarget(root, context);
  const kubeconfig = target.kubeconfig;
  process.env.KUBECONFIG = kubeconfig;
  const reviews = resolve(root, '.artifacts/neo/review');
  await mkdir(reviews, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(reviews, 'run-'));
  const source = JSON.parse(await readFile(resolve(root, '.artifacts/neo/source.json'), 'utf8'));
  const images = context === REVIEW_CONTEXT ? readReviewImages(root, source.commit) : undefined;
  const profile = neoKubernetesProfile({ context, ...(images ? { nodeImage: images.nodeImage, pythonImage: images.pythonImage } : {}) });
  const design = createNeoSystem();
  const binding = bindSystem(design, profile);
  const stateDirectory = target.stateDirectory ?? join(directory, 'state');
  const engine = new InfraEngine({
    adapters: [new KubernetesAdapter({ context, namespace: NEO_NAMESPACE, timeoutMs: 180_000 })],
    store: new FileStateStore(stateDirectory), traceDirectory: join(directory, 'traces'), maxConcurrency: 2,
  });
  const report: Record<string, unknown> = {
    status: 'running', startedAt: new Date().toISOString(), context, kubeconfig, namespace: NEO_NAMESPACE,
    directory, stateDirectory, sourceCommit: source.commit, frameworkVersion: '0.4.0', images,
    scope: 'Actual Kubernetes-hosted Neo Node/UI and Python fixture; scripted model and seeded SQLite; no live collectors.',
  };
  await writeJson(join(directory, 'design.json'), design);
  await writeJson(join(directory, 'binding.json'), binding);
  await writeFile(join(directory, 'intent.mmd'), systemToMermaid(design), { mode: 0o600 });
  await writeFile(join(directory, 'resources.mmd'), graphToMermaid(binding.graph, { view: 'architecture', boundaryKind: 'group' }), { mode: 0o600 });
  await writeJson(join(directory, 'report.json'), report);
  try {
    const initial = await engine.apply(binding.graph);
    await writeJson(join(directory, 'initial-apply.json'), initial);
    assert.equal(initial.ok, true, initial.failure?.message);
    console.log('PASS real Neo capability binding, apply and readiness');
    const baseline = await probeDeployment(context, kubeconfig);
    assert.equal(baseline.replicas, 1);
    const noop = await engine.plan(binding.graph);
    assert.ok(noop.operations.every(operation => operation.action === 'noop'));
    console.log('PASS unchanged deployment is all no-op');
    const scale = await engine.apply(bindSystem(createNeoSystem({ replicas: 2 }), profile).graph);
    assert.equal(scale.ok, true, scale.failure?.message);
    const two = await probeDeployment(context, kubeconfig);
    assert.equal(two.replicas, 2); assert.equal(two.updated, 2); assert.ok(two.available >= 2);
    assert.deepEqual(two.stable, baseline.stable);
    const restored = await engine.apply(binding.graph);
    assert.equal(restored.ok, true, restored.failure?.message);
    const final = await probeDeployment(context, kubeconfig);
    assert.equal(final.replicas, 1); assert.equal(final.updated, 1); assert.ok(final.available >= 1);
    assert.deepEqual(final.stable, baseline.stable);
    assert.ok((await engine.plan(binding.graph)).operations.every(operation => operation.action === 'noop'));
    console.log('PASS real scale 1→2→1 preserves identity and app configuration');
    const forwarding = await startReviewForward({ context, kubeconfig, directory });
    const health = await smoke(forwarding.baseUrl, forwarding.pythonUrl);
    Object.assign(report, {
      status: 'passed', finishedAt: new Date().toISOString(), designDigest: design.digest,
      bindingDigest: binding.digest, graphDigest: binding.graph.digest, deploymentUid: final.stable.uid,
      initialRunId: initial.runId, initialEvidencePath: initial.evidencePath, finalRunId: restored.runId,
      finalEvidencePath: restored.evidencePath, finalTracePath: restored.tracePath,
      checks: ['capability-to-real-kubernetes', 'ready-node-and-python', 'unchanged-noop', 'real-scale-1-2-1',
        'unchanged-deployment-identity-and-template', ...health.checks], forwarding,
      baseUrl: forwarding.baseUrl, pythonUrl: forwarding.pythonUrl,
    });
    await writeJson(join(directory, 'report.json'), report);
    await writeJson(join(reviews, 'latest.json'), report);
    console.log(`PASS real app HTML, health and seeded query; review server ${forwarding.baseUrl}`);
    console.log(`Report: ${join(directory, 'report.json')}`);
    return report;
  } catch (error) {
    Object.assign(report, { status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    await writeJson(join(directory, 'report.json'), report);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--context') throw new Error('Usage: npm run neo:review -- --context kind-footprint-iac-review');
  await runNeoReview(process.argv[3]!);
}

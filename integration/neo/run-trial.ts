import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { InfraEngine, FileStateStore, KubernetesAdapter, backwalk, loadEvidence, replay, type ApplyResult, type JsonObject, type Plan } from '../../src/index.ts';
import { createNeoStack, NEO_NAMESPACE } from './stack.ts';
import { smoke } from './smoke.mjs';
import { readNeoNativeMutationFailure } from './native-mutation-failure.ts';

const usage = 'Usage: node integration/neo/run-trial.ts --context LOCAL_CONTEXT\nKUBECONFIG is inherited. This runs only the local seeded Neo fixture and leaves its workloads available.';
const root = fileURLToPath(new URL('../../', import.meta.url));

export function trialContext(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--context' || !argv[1] || argv[1].startsWith('-')
    || argv[1].trim() !== argv[1] || /[\u0000-\u001f\u007f]/.test(argv[1])) throw new Error(usage);
  return argv[1];
}

function actions(plan: Plan) {
  return plan.operations.map(operation => ({ resourceId: operation.resource.id, action: operation.action }));
}

async function deploymentProbe(context: string) {
  // Reads independently check the live API object; all writes still use InfraEngine.
  const { stdout } = await promisify(execFile)('kubectl', [
    '--context', context, '--request-timeout=30s', '--namespace', NEO_NAMESPACE,
    'get', 'deployment', 'neo', '-o', 'json',
  ], { env: process.env, timeout: 31_000, maxBuffer: 2 * 1024 * 1024 });
  const live = JSON.parse(stdout) as {
    kind: string;
    metadata: { name: string; namespace: string; uid: string; labels?: unknown; annotations?: unknown };
    spec: { replicas: number; selector: unknown; strategy: unknown; template: unknown };
    status: { availableReplicas?: number; updatedReplicas?: number };
  };
  assert.equal(live.kind, 'Deployment');
  assert.equal(live.metadata.name, 'neo');
  assert.equal(live.metadata.namespace, NEO_NAMESPACE);
  assert.equal(typeof live.metadata.uid, 'string');
  return {
    replicas: live.spec.replicas,
    availableReplicas: live.status.availableReplicas ?? 0,
    updatedReplicas: live.status.updatedReplicas ?? 0,
    uid: live.metadata.uid,
    stable: {
      // Generation, resourceVersion, managedFields and status are server bookkeeping.
      // Resource identity, application metadata, images and the full pod template must stay fixed.
      metadata: {
        name: live.metadata.name, namespace: live.metadata.namespace, uid: live.metadata.uid,
        labels: live.metadata.labels ?? {}, annotations: live.metadata.annotations ?? {},
      },
      selector: live.spec.selector, strategy: live.spec.strategy, template: live.spec.template,
    },
  };
}

function forward(context: string): { child: ChildProcess; ready: Promise<{ node: string; python: string }> } {
  // Empty local ports ask kubectl to reserve available loopback ports atomically.
  const child = spawn('kubectl', [
    '--context', context, '--request-timeout=30s', '--namespace', NEO_NAMESPACE,
    'port-forward', 'deployment/neo', ':5230', ':8000', '--address', '127.0.0.1',
  ], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const ready = new Promise<{ node: string; python: string }>((accept, reject) => {
    let settled = false;
    const ports = new Map<number, number>();
    const timer = setTimeout(() => finish(new Error('kubectl port-forward did not open both local ports in 30 seconds.')), 30_000);
    function finish(error?: Error) {
      if (settled) return;
      if (!error && (!ports.has(5230) || !ports.has(8000))) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept({ node: `http://127.0.0.1:${ports.get(5230)!}`, python: `http://127.0.0.1:${ports.get(8000)!}` });
    }
    function collect(chunk: Buffer) {
      logs = (logs + chunk.toString()).slice(-16_384);
      for (const match of logs.matchAll(/Forwarding from 127\.0\.0\.1:(\d+) -> (5230|8000)/g)) {
        ports.set(Number(match[2]), Number(match[1]));
      }
      finish();
    }
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', error => finish(error));
    child.on('close', code => finish(new Error(`kubectl port-forward exited before opening both ports (exit ${code}).`)));
  });
  return { child, ready };
}

async function stopForward(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const wait = (milliseconds: number) => new Promise<void>(accept => {
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); child!.off('close', done); accept(); }
    child!.once('close', done);
  });
  const graceful = wait(3_000);
  child.kill('SIGTERM');
  await graceful;
  if (child.exitCode === null && child.signalCode === null) {
    const forced = wait(2_000);
    child.kill('SIGKILL');
    await forced;
  }
}

export async function runNeoTrial(context: string): Promise<string> {
  // Revalidate the programmatic entry, too. The namespace/state location are fixed.
  trialContext(['--context', context]);
  const directory = resolve(root, '.artifacts/neo');
  const stateDirectory = resolve(directory, 'state');
  const reportPath = resolve(directory, 'trial-report.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report: {
    status: 'running' | 'passed' | 'failed'; startedAt: string; finishedAt?: string;
    context: string; namespace: string; stateDirectory: string; scope: string;
    sourceCommit?: string; evidencePath?: string; tracePath?: string;
    error?: string; recoveryError?: string; steps: Record<string, unknown>[];
  } = {
    status: 'running', startedAt: new Date().toISOString(), context,
    namespace: NEO_NAMESPACE, stateDirectory,
    scope: 'Real local Kubernetes deployment and seeded SQLite query; no LLM calls or live collectors.',
    steps: [],
  };
  try {
    const source = JSON.parse(await readFile(resolve(directory, 'source.json'), 'utf8')) as { commit?: unknown };
    if (typeof source.commit === 'string') report.sourceCommit = source.commit;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const step = async (name: string, facts: Record<string, unknown>) => {
    report.steps.push({ name, ...facts });
    await save();
    console.log(`${facts.ok === false ? 'FAIL' : 'PASS'} ${name}`);
  };
  const recordApply = (name: string, result: ApplyResult) => step(name, {
    ok: result.ok, runId: result.runId, actions: actions(result.plan), evidencePath: result.evidencePath,
    tracePath: result.tracePath, traceStatus: result.traceStatus, failure: result.failure,
  });
  const adapter = new KubernetesAdapter({ context, namespace: NEO_NAMESPACE, timeoutMs: 180_000 });
  const store = new FileStateStore(stateDirectory);
  const engine = new InfraEngine({ adapters: [adapter], store, traceDirectory: resolve(directory, 'traces') });
  const desired = createNeoStack();
  const deployment = desired.resources.find(resource => resource.id === 'neo-app')!;
  const inspection = { stack: desired.name, operationId: 'local-trial-inspection' };
  let portForward: ChildProcess | undefined;
  let needsRestore = false;
  await save();
  try {
    const initialPlan = await engine.plan(desired);
    await step('initial plan', { ok: true, actions: actions(initialPlan) });
    const initial = await engine.apply(desired);
    await recordApply('apply and readiness', initial);
    assert.equal(initial.ok, true, initial.failure?.message);

    const unchanged = await engine.plan(desired);
    assert.ok(unchanged.operations.every(operation => operation.action === 'noop'), 'Unchanged resources must plan as no-op.');
    await step('unchanged plan', { ok: true, actions: actions(unchanged) });
    const reapplied = await engine.apply(desired);
    await recordApply('unchanged reapply', reapplied);
    assert.equal(reapplied.ok, true, reapplied.failure?.message);
    assert.ok(reapplied.plan.operations.every(operation => operation.action === 'noop'));

    const baseline = await deploymentProbe(context);
    assert.equal(baseline.replicas, 1);
    const scaled = structuredClone(desired);
    const scaledDeployment = scaled.resources.find(resource => resource.id === 'neo-app')!;
    (scaledDeployment.spec.spec as JsonObject).replicas = 2;
    const scalePlan = await engine.plan(scaled);
    assert.equal(scalePlan.operations.find(operation => operation.resource.id === 'neo-app')?.action, 'update');
    assert.ok(scalePlan.operations.filter(operation => operation.resource.id !== 'neo-app').every(operation => operation.action === 'noop'));
    await step('scale-only update plan', { ok: true, actions: actions(scalePlan) });
    needsRestore = true;
    const scaleUp = await engine.apply(scaled);
    await recordApply('scale from one to two replicas', scaleUp);
    assert.equal(scaleUp.ok, true, scaleUp.failure?.message);
    const atTwo = await deploymentProbe(context);
    assert.equal(atTwo.replicas, 2);
    assert.equal(atTwo.updatedReplicas, 2);
    assert.ok(atTwo.availableReplicas >= 2);
    assert.deepEqual(atTwo.stable, baseline.stable, 'Scaling must preserve deployment identity, application metadata, images and pod template.');
    assert.equal((await adapter.observe(scaledDeployment, inspection)).ready, true);
    await step('two replicas ready with unchanged configuration', {
      ok: true, replicas: atTwo.replicas, availableReplicas: atTwo.availableReplicas,
      deploymentUid: atTwo.uid, identityMetadataImagesAndPodTemplateUnchanged: true,
    });

    const scaleDown = await engine.apply(desired);
    await recordApply('scale back to one replica', scaleDown);
    assert.equal(scaleDown.ok, true, scaleDown.failure?.message);
    const backAtOne = await deploymentProbe(context);
    assert.equal(backAtOne.replicas, 1);
    assert.equal(backAtOne.updatedReplicas, 1);
    assert.ok(backAtOne.availableReplicas >= 1);
    assert.deepEqual(backAtOne.stable, baseline.stable, 'Scaling back must preserve deployment identity and configuration.');
    assert.equal((await adapter.observe(deployment, inspection)).ready, true);
    const afterScaling = await engine.plan(desired);
    assert.ok(afterScaling.operations.every(operation => operation.action === 'noop'));
    needsRestore = false;
    await step('scaling restored to one ready replica and no-op', {
      ok: true, replicas: backAtOne.replicas, deploymentUid: backAtOne.uid,
      identityMetadataImagesAndPodTemplateUnchanged: true, actions: actions(afterScaling),
    });

    // Start forwarding only after scaling back, so the selected pod is stable.
    const forwarding = forward(context);
    portForward = forwarding.child;
    const endpoints = await forwarding.ready;
    await step('real app and seeded-query smoke', { ok: true, result: await smoke(endpoints.node, endpoints.python) });
    const before = await adapter.observe(deployment, inspection);
    assert.equal(before.owned, true);
    assert.equal(before.ready, true);

    // Request an invalid replica count and retain the actual command boundary.
    // Bounded native failure evidence does not classify a server rejection versus transport failure.
    const invalid = structuredClone(desired);
    const invalidDeployment = invalid.resources.find(resource => resource.id === 'neo-app')!;
    (invalidDeployment.spec.spec as JsonObject).replicas = -1;
    needsRestore = true;
    const failed = await engine.apply(invalid);
    report.evidencePath = failed.evidencePath;
    report.tracePath = failed.tracePath;
    const nativeFailure=await readNeoNativeMutationFailure(failed,invalidDeployment);
    await step('invalid desired deployment fails with a recorded mutation outcome', {
      ok: !failed.ok, expectedFailure: true, operationSucceeded: failed.ok, runId: failed.runId,
      failure: failed.failure, nativeFailure, evidencePath: failed.evidencePath, tracePath: failed.tracePath,
    });
    assert.equal(failed.ok, false, 'The invalid desired deployment must not be reported as successful.');
    assert.equal(failed.failure?.resourceId, 'neo-app');
    assert.equal((invalidDeployment.spec.spec as JsonObject).replicas,-1);
    assert.equal(nativeFailure.status,'unconfirmed');
    assert.equal(failed.traceStatus?.flushed, true, 'The official runtime trace must flush.');
    assert.equal(failed.traceStatus?.failed, 0);
    assert.ok(failed.tracePath);
    assert.ok((await stat(failed.tracePath)).size > 0);

    // These read-only operations have no provider adapter or execution capability.
    const evidence = await loadEvidence(failed.evidencePath);
    const investigation = backwalk(evidence, 'failure');
    assert.ok(investigation.slice.root, 'The recorded failure must have a writer.');
    assert.match(investigation.text, /Reconcile neo-app/);
    assert.match(investigation.text, /Load desired resources/);
    const folded = replay(evidence);
    assert.deepEqual(folded.state, evidence.snapshot.sharedState);
    assert.equal((folded.state.failure as { resourceId?: string } | null)?.resourceId, 'neo-app');
    const beforeFailure = replay(evidence, 0);
    assert.equal(beforeFailure.state.failed, false);
    assert.equal(beforeFailure.state.failure, null);
    await writeFile(resolve(directory, 'failure-backwalk.txt'), investigation.text + '\n', { mode: 0o600 });
    await step('saved Foottrace replay and backwalk', {
      ok: true, evidencePath: failed.evidencePath, tracePath: failed.tracePath,
      replayMatchesRecordedState: true, backwalkPath: resolve(directory, 'failure-backwalk.txt'),
      note: 'Recorded program dependencies localize the rejected input; they do not prove a provider-internal root cause.',
    });

    await adapter.waitReady(deployment, inspection);
    const retained = await adapter.observe(deployment, inspection);
    assert.equal(retained.owned, true);
    assert.equal(retained.ready, true);
    assert.equal(retained.fingerprint, before.fingerprint, 'The failed update must leave the declared deployment fields unchanged.');
    await step('existing deployment survives the failed change', { ok: true, ready: retained.ready, desiredFieldsUnchanged: true });
    await step('app smoke after failed change', { ok: true, result: await smoke(endpoints.node, endpoints.python) });

    const restored = await engine.apply(desired);
    await recordApply('restore valid desired state', restored);
    assert.equal(restored.ok, true, restored.failure?.message);
    needsRestore = false;
    const finalPlan = await engine.plan(desired);
    assert.ok(finalPlan.operations.every(operation => operation.action === 'noop'), 'The repaired stack must converge to all no-op.');
    await step('final no-op convergence', { ok: true, actions: actions(finalPlan) });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    if (needsRestore) {
      try {
        const recovery = await engine.apply(desired);
        await recordApply('restore after trial assertion failure', recovery);
        if (!recovery.ok) report.recoveryError = recovery.failure?.message ?? 'Restoration did not succeed.';
      } catch (recoveryError) {
        report.recoveryError = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      }
    }
    throw error;
  } finally {
    await stopForward(portForward);
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(`Trial report: ${reportPath}`);
  }
  return reportPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
  else {
    try { await runNeoTrial(trialContext(process.argv.slice(2))); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import { fingerprint, project } from '../src/util.ts';
import type { JsonObject, Observation, Resource, ResourceAdapter, Stack } from '../src/types.ts';

test('SIGKILL after provider create reconciles on restart without a second apply', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-engine-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url)), directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr += String(data); });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Child did not persist the provider effect: ${stderr}`)), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += String(data);
      if (output.includes('provider-effect-persisted\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Child exited before the provider effect: ${code}/${signal}: ${stderr}`));
    });
  });
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  const [, signal] = await exit;
  assert.equal(signal, 'SIGKILL');

  const store = new FileStateStore(join(directory, 'state'));
  const before = await store.load('crash-recovery');
  assert.ok(before.resources.worker, 'desired inventory is checkpointed before the provider send');
  assert.equal(before.resources.worker.fingerprint, '', 'no completed fingerprint was checkpointed');
  const journalBefore = await store.readJournal();
  assert.ok(journalBefore.some(entry => entry.event === 'begin'));
  assert.equal(journalBefore.some(entry => entry.event === 'complete'), false);
  const providerBefore = JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8')) as Record<string, { physicalId: string }>;
  assert.equal(providerBefore.worker?.physicalId, 'sim://worker');

  const stack: Stack = {
    name: 'crash-recovery',
    resources: [{ id: 'worker', provider: 'simulator', spec: { image: 'worker:v1', replicas: 1 } }],
  };
  const adapter = new SimulatorAdapter({ file: join(directory, 'provider.json') });
  const engine = new InfraEngine({ adapters: [adapter], store });
  const result = await engine.apply(stack);
  assert.equal(result.ok, true);
  assert.equal(adapter.calls.filter(call => call.action === 'apply').length, 0,
    'a confirmed create must not be sent again merely because the worker died before its completion checkpoint');
  assert.equal((await store.load(stack.name)).resources.worker?.fingerprint, fingerprint(stack.resources[0]!.spec));
  const next = await engine.plan(stack);
  assert.deepEqual(next.operations.map(operation => operation.action), ['noop']);
  assert.equal((await engine.apply(stack)).ok, true);
  assert.equal(adapter.calls.length, 0);
  const providerAfter = JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8')) as Record<string, { physicalId: string }>;
  assert.equal(providerAfter.worker?.physicalId, providerBefore.worker?.physicalId);
});

test('an update removing a field cannot claim convergence from new-spec projection after a failed send', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-update-omission-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  class ProjectionAdapter implements ResourceAdapter {
    readonly name = 'projection';
    readonly scope = 'test';
    readonly supportsSafeRetry = true;
    live: JsonObject | undefined;
    rejectUpdates = false;
    async observe(resource: Resource): Promise<Observation> {
      return this.live ? { exists: true, owned: true, ready: true, physicalId: 'projection://config', fingerprint: fingerprint(project(this.live, resource.spec)) }
        : { exists: false, physicalId: 'projection://config' };
    }
    async apply(resource: Resource): Promise<void> {
      if (this.rejectUpdates) throw new Error('Provider denied update before applying it');
      this.live = structuredClone(resource.spec);
    }
    async remove(): Promise<void> { this.live = undefined; }
    async waitReady(): Promise<void> {}
  }
  const adapter = new ProjectionAdapter();
  const store = new FileStateStore(directory);
  const engine = new InfraEngine({ adapters: [adapter], store });
  const original: Stack = { name: 'field-removal', resources: [{ id: 'config', provider: adapter.name, spec: { value: 1, removed: 'still-present' } }] };
  assert.equal((await engine.apply(original)).ok, true);
  adapter.rejectUpdates = true;
  const desired: Stack = { name: original.name, resources: [{ id: 'config', provider: adapter.name, spec: { value: 1 } }] };
  const result = await engine.apply(desired);
  assert.equal(adapter.live?.removed, 'still-present');
  assert.equal(result.ok, false, 'matching only the surviving fields cannot establish that the rejected update removed an old field');
  assert.equal((await store.load(original.name)).resources.config?.fingerprint, fingerprint(original.resources[0]!.spec));
});

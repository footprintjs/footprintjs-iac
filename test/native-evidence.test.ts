import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { SimulatorAdapter } from '../src/providers/simulator.ts';
import type { Stack } from '../src/types.ts';

const stack: Stack = {
  name: 'native-evidence',
  resources: [{ id: 'worker', provider: 'simulator', spec: { image: 'worker:v1', replicas: 1 } }],
};

test('native FootPrint JSONL replays through Foottrace independently of the final snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-native-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await new InfraEngine({
    adapters: [new SimulatorAdapter()], store: new FileStateStore(join(directory, 'state')),
    traceDirectory: join(directory, 'traces'),
  }).apply(stack);
  assert.equal(result.ok, true);
  assert.ok(result.tracePath);
  assert.deepEqual(result.traceStatus, { entries: result.traceStatus?.entries, failed: 0, flushed: true });
  assert.ok(result.traceStatus.entries > 0);
  const file = readRecordFile(result.tracePath);
  assert.deepEqual(file.unreadable, []);
  const stored = readStoredRecord(file.entries);
  assert.deepEqual(stored.unread, []);
  const root = [...stored.logs.values()].find(log => log.address.drillPath.length === 0);
  assert.ok(root);
  assert.equal(root.complete, true);
  assert.deepEqual(root.gaps, []);
  const replay = stateAt(root.source(), root.commitLog.length - 1);
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as {
    snapshot: { sharedState: unknown }; traceStatus: unknown; tracePath: string;
  };
  assert.deepEqual(replay.state, evidence.snapshot.sharedState);
  assert.deepEqual(evidence.traceStatus, result.traceStatus);
  assert.equal(evidence.tracePath, result.tracePath);
});

test('a runtime trace setup failure is disclosed without changing successful provider work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-native-refused-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const traceDirectory = join(directory, 'not-a-directory');
  await writeFile(traceDirectory, 'do not replace');
  const adapter = new SimulatorAdapter();
  const store = new FileStateStore(join(directory, 'state'));
  const result = await new InfraEngine({ adapters: [adapter], store, traceDirectory }).apply(stack);
  assert.equal(result.ok, true);
  assert.equal(adapter.calls.length, 1);
  assert.equal(result.traceStatus?.failed, 1);
  assert.equal(result.traceStatus?.flushed, false);
  assert.match(result.traceStatus?.error ?? '', /Runtime trace setup failed/);
  assert.ok((await store.readJournal()).some(entry => entry.event === 'complete'));
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')) as { traceStatus: unknown };
  assert.deepEqual(evidence.traceStatus, result.traceStatus);
  assert.equal(await readFile(traceDirectory, 'utf8'), 'do not replace');
});

test('a killed engine leaves a native record explicitly marked incomplete', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-native-kill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engineModule = new URL('../src/engine.ts', import.meta.url).href;
  const storeModule = new URL('../src/store.ts', import.meta.url).href;
  const simulatorModule = new URL('../src/providers/simulator.ts', import.meta.url).href;
  const traceDirectory = join(directory, 'traces');
  const script = `
    import { InfraEngine } from ${JSON.stringify(engineModule)};
    import { FileStateStore } from ${JSON.stringify(storeModule)};
    import { SimulatorAdapter } from ${JSON.stringify(simulatorModule)};
    const adapter = new SimulatorAdapter({ file: ${JSON.stringify(join(directory, 'provider.json'))}, faults: {
      afterEffect: async () => {
        process.stdout.write('effect-persisted\\n');
        await new Promise(() => { setInterval(() => {}, 1000); });
      },
    } });
    await new InfraEngine({ adapters: [adapter], store: new FileStateStore(${JSON.stringify(join(directory, 'state'))}), traceDirectory: ${JSON.stringify(traceDirectory)} }).apply(${JSON.stringify(stack)});
    throw new Error('The engine unexpectedly finished');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Native trace child timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('effect-persisted\n')) { clearTimeout(timer); resolve(); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Native trace child exited ${code}/${signal}: ${stderr}`)); });
  });
  // Before killing, verify that at least one asynchronously written commit landed.
  // This is evidence-specific synchronization, not an engine durability claim.
  const names = await readdir(traceDirectory);
  assert.equal(names.length, 1);
  const tracePath = join(traceDirectory, names[0]!);
  const deadline = Date.now() + 1000;
  let before = readRecordFile(tracePath);
  while (!before.entries.some(entry => (entry as { kind?: unknown }).kind === 'commit') && Date.now() < deadline) {
    await delay(10);
    before = readRecordFile(tracePath);
  }
  assert.ok(before.entries.some(entry => (entry as { kind?: unknown }).kind === 'commit'));
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  const [, signal] = await exit;
  assert.equal(signal, 'SIGKILL');
  const file = readRecordFile(tracePath);
  const stored = readStoredRecord(file.entries);
  const root = [...stored.logs.values()].find(log => log.address.drillPath.length === 0);
  assert.ok(root);
  assert.equal(root.complete, false);
  assert.equal(root.outcome, undefined);
  const replay = stateAt(root.source(), root.commitLog.length - 1);
  assert.equal(replay.state.failed, false);
  assert.equal(Object.hasOwn(replay.state, 'result:worker'), false, 'the interrupted resource stage never committed a result');
  assert.equal((await readdir(join(directory, 'state'))).some(name => name.startsWith('run-')), false,
    'no final snapshot was needed to retain the native prefix');
});

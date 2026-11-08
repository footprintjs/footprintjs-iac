import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStateStore } from '../src/store.ts';
import type { JournalEntry, StackState } from '../src/types.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new FileStateStore(directory);
}

test('state, journal and evidence persist independently with private file modes', async t => {
  const store = await fixture(t);
  const state: StackState = {
    version: 1, stack: 'demo', resources: {
      config: { resource: { id: 'config', provider: 'simulator', spec: { value: 1 } }, fingerprint: 'abc', physicalId: 'config-1' },
    },
  };
  assert.deepEqual(await store.load('demo'), { version: 1, stack: 'demo', resources: {} });
  await store.save(state);
  assert.deepEqual(await new FileStateStore(store.directory).load('demo'), state);
  const entry: JournalEntry = { event: 'begin', runId: 'r1', operationId: 'o1', resourceId: 'config', action: 'create', at: new Date().toISOString() };
  await store.append(entry);
  assert.deepEqual(await store.readJournal(), [entry]);
  const evidence = { snapshot: { status: 'failed' }, complete: false };
  const path = await store.saveEvidence('run-1', evidence);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), evidence);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(store.statePath('demo'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(store.directory, 'journal.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await readdir(store.directory)).some(name => name.includes('.tmp-')), false);
});

test('identifiers cannot escape the store directory', async t => {
  const store = await fixture(t);
  const name = '../../outside';
  const path = store.statePath(name);
  assert.equal(dirname(path), store.directory);
  await store.save({ version: 1, stack: name, resources: {} });
  assert.equal((await store.load(name)).stack, name);
  assert.equal(dirname(await store.saveEvidence('../run', {})), store.directory);
  assert.throws(() => store.statePath(''), /identifiers/);
});

test('corrupt or wrong-stack state is never silently treated as empty', async t => {
  const store = await fixture(t);
  await writeFile(store.statePath('demo'), '{');
  await assert.rejects(store.load('demo'), /not valid JSON/);
  await writeFile(store.statePath('demo'), JSON.stringify({ version: 1, stack: 'other', resources: {} }));
  await assert.rejects(store.load('demo'), /Invalid state/);
  await writeFile(store.statePath('demo'), JSON.stringify({ version: 1, stack: 'demo', resources: { x: { fingerprint: 'f', resource: { id: 'wrong', provider: 'sim', spec: {} } } } }));
  await assert.rejects(store.load('demo'), /Invalid resource definition/);
  await writeFile(store.statePath('demo'), JSON.stringify({ version: 1, stack: 'demo', resources: {}, providerScopes: { simulator: 42 } }));
  await assert.rejects(store.load('demo'), /Invalid provider scopes/);
  await writeFile(store.statePath('demo'), JSON.stringify({ version: 1, stack: 'demo', resources: {
    x: { fingerprint: '', resource: { id: 'x', provider: 'sim', spec: {} },
      pending: { operationId: 'operation', action: 'delete', desiredFingerprint: 'desired' } },
  } }));
  await assert.rejects(store.load('demo'), /Invalid pending operation/);
});

test('a live lock excludes another apply and releases after errors', async t => {
  const store = await fixture(t);
  await store.withLock('demo', async () => {
    await assert.rejects(new FileStateStore(store.directory).withLock('demo', async () => undefined), /locked by live PID/);
    // Other stacks have independent locks.
    await store.withLock('other', async () => undefined);
  });
  await assert.rejects(store.withLock('demo', async () => { throw new Error('work failed'); }), /work failed/);
  assert.equal(await store.withLock('demo', async () => 'released'), 'released');
});

test('a killed owner leaves durable intent and a recoverable stale lock', async t => {
  const store = await fixture(t);
  const moduleUrl = new URL('../src/store.ts', import.meta.url).href;
  const script = `
    import { FileStateStore } from ${JSON.stringify(moduleUrl)};
    const store = new FileStateStore(${JSON.stringify(store.directory)});
    await store.withLock('demo', async () => {
      await store.append({ event: 'begin', runId: 'crashed', operationId: 'operation', resourceId: 'vm', action: 'create', at: new Date().toISOString() });
      process.stdout.write('locked\\n');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { if (String(data).includes('locked')) resolve(); });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Child exited before holding its lock: ${code}: ${stderr}`)));
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal((await store.readJournal())[0]?.event, 'begin');
  assert.equal(await store.withLock('demo', async () => 'recovered'), 'recovered');
});

test('malformed and incomplete locks fail closed', async t => {
  const store = await fixture(t);
  const path = store.lockPath('demo');
  await mkdir(path);
  await assert.rejects(store.withLock('demo', async () => undefined), /incomplete or unreadable lock/);
  await writeFile(join(path, 'owner.json'), '{"pid":0,"token":"invalid"}');
  await assert.rejects(store.withLock('demo', async () => undefined), /malformed lock/);
  assert.deepEqual(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')), { pid: 0, token: 'invalid' });
});

test('contenders reclaiming one dead owner never enter concurrently', async t => {
  const store = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.ok(child.pid);
  const path = store.lockPath('demo');
  await mkdir(path);
  await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: child.pid, token: 'dead-owner' }));
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => store.withLock('demo', async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    completed++;
  })));
  assert.equal(maxActive, 1);
  assert.ok(completed >= 1);
  for (const result of results) {
    if (result.status === 'rejected') assert.match(String(result.reason), /locked|reclamation|lock/);
  }
  assert.equal(await store.withLock('demo', async () => 'available'), 'available');
});

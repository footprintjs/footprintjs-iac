import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ApplyResult } from '../src/engine.ts';
import type { Plan } from '../src/types.ts';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stackPath = join(directory, 'stack.json');
  const stateDirectory = join(directory, 'state');
  await writeFile(stackPath, JSON.stringify({ name: 'cli-demo', resources: [
    { id: 'app', provider: 'simulator', spec: { value: 7 } },
  ] }));
  async function run(args: string[]) {
    try {
      const result = await execute(process.execPath, [cli, ...args], {
        cwd: directory, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
        // Nothing in these tests may discover/run kubectl or another network-facing executable.
        env: { ...process.env, PATH: '', HTTP_PROXY: '', HTTPS_PROXY: '' },
      });
      return { status: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string; stderr?: string };
      return { status: result.code ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.message };
    }
  }
  return { directory, stackPath, stateDirectory, run };
}

test('CLI runs local plan/apply/noop, explains evidence, replays recorded state and destroys saved resources', async t => {
  const { stackPath, stateDirectory, run } = await fixture(t);
  const command = (verb: string) => [verb, stackPath, '--state-dir', stateDirectory];
  const plan = await run(command('plan'));
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal((JSON.parse(plan.stdout) as Plan).operations[0]!.action, 'create');

  const applied = await run(command('apply'));
  assert.equal(applied.status, 0, applied.stderr);
  const first = JSON.parse(applied.stdout) as ApplyResult;
  assert.equal(first.ok, true);
  assert.equal(first.plan.operations[0]!.action, 'create');
  assert.ok(first.tracePath, 'apply must return an actual native trace path');
  const traceRows = (await readFile(first.tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown);
  assert.ok(traceRows.length > 2, 'native trace must contain persisted execution records');

  const unchanged = await run(command('plan'));
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal((JSON.parse(unchanged.stdout) as Plan).operations[0]!.action, 'noop');

  const explanation = await run(['explain', first.evidencePath, '--key', 'result:app']);
  assert.equal(explanation.status, 0, explanation.stderr);
  assert.match(explanation.stdout, /Reconcile app/);
  assert.match(explanation.stdout, /Load desired resources/);

  const replay = await run(['replay', first.evidencePath]);
  assert.equal(replay.status, 0, replay.stderr);
  const folded = JSON.parse(replay.stdout) as { state: Record<string, unknown>; basis: string };
  assert.equal(folded.state.failed, false);
  assert.deepEqual(folded.state['desired:app'], { value: 7 });
  assert.equal((folded.state['result:app'] as { status: string }).status, 'complete');
  const base = await run(['replay', first.evidencePath, '--commit', '-1']);
  assert.equal(base.status, 0, base.stderr);
  assert.deepEqual((JSON.parse(base.stdout) as { state: unknown }).state, {});

  const destroyed = await run(command('destroy'));
  assert.equal(destroyed.status, 0, destroyed.stderr);
  const destruction = JSON.parse(destroyed.stdout) as ApplyResult;
  assert.equal(destruction.ok, true);
  assert.deepEqual(destruction.plan.operations.map(operation => operation.action), ['delete']);
  const recreate = await run(command('plan'));
  assert.equal(recreate.status, 0, recreate.stderr);
  assert.equal((JSON.parse(recreate.stdout) as Plan).operations[0]!.action, 'create');
});

test('CLI rejects unknown commands/options and incomplete option values with a failing exit status', async t => {
  const { stackPath, stateDirectory, run } = await fixture(t);
  const unknownCommand = await run(['unknown', stackPath, '--state-dir', stateDirectory]);
  assert.notEqual(unknownCommand.status, 0);
  assert.match(unknownCommand.stderr, /Usage:/);
  const unknownOption = await run(['plan', stackPath, '--unsafe']);
  assert.notEqual(unknownOption.status, 0);
  assert.match(unknownOption.stderr, /Unknown option: --unsafe/);
  const missingValue = await run(['plan', stackPath, '--context']);
  assert.notEqual(missingValue.status, 0);
  assert.match(missingValue.stderr, /Missing value for --context/);
  const duplicate = await run(['plan', stackPath, '--state-dir', stateDirectory, '--state-dir', stateDirectory]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Repeated option/);
});

test('CLI refuses Kubernetes work without an explicitly supplied context before any provider command', async t => {
  const { stackPath, stateDirectory, run } = await fixture(t);
  await writeFile(stackPath, JSON.stringify({ name: 'local-kubernetes', resources: [
    { id: 'config', provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'local-test' }, data: { value: '7' } } },
  ] }));
  const result = await run(['plan', stackPath, '--state-dir', stateDirectory]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Kubernetes requires an explicit --context/);
  assert.equal(result.stdout, '');
});

test('CLI rejects replay commit indexes outside the persisted record', async t => {
  const { stackPath, stateDirectory, run } = await fixture(t);
  const applied = await run(['apply', stackPath, '--state-dir', stateDirectory]);
  assert.equal(applied.status, 0, applied.stderr);
  const { evidencePath } = JSON.parse(applied.stdout) as ApplyResult;
  for (const commit of ['-2', '99999', 'not-a-number']) {
    const result = await run(['replay', evidencePath, '--commit', commit]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Commit is outside the recorded range/);
  }
});

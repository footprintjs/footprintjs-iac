import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { infra, resource } from '../src/graph/index.ts';
import { cleanupStack } from '../src/cli/cleanup-stack.ts';
import type { ApplyResult } from '../src/engine.ts';
import type { StackState } from '../src/types.ts';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('CLI applies and inspects graph artifacts, retains design metadata and supports graph cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-cli-graph-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'graph.json');
  const state = join(directory, 'state');
  const app = resource('app', 'simulator', { value: 1 });
  const graph = infra('cli-graph').boundary({ id: 'room-a', kind: 'physical' }).within('room-a', app).synth();
  await writeFile(path, JSON.stringify(graph));
  const run = (args: string[]) => execute(process.execPath, [cli, ...args], { cwd: directory, timeout: 15000, env: { ...process.env, PATH: '' } });
  const result = JSON.parse((await run(['apply', path, '--state-dir', state, '--max-concurrency', '2'])).stdout) as ApplyResult;
  assert.equal(result.ok, true);
  const saved = JSON.parse(await readFile(result.evidencePath, 'utf8')) as { graph: { digest: string } };
  assert.equal(saved.graph.digest, graph.digest);
  const inspection = JSON.parse((await run(['inspect', result.evidencePath, '--key', 'result:app'])).stdout) as { design: { digest: string }; dependencies: { writerId: string } };
  assert.equal(inspection.design.digest, graph.digest);
  assert.ok(inspection.dependencies.writerId);
  const cleaned = JSON.parse((await run(['destroy', path, '--state-dir', state])).stdout) as ApplyResult;
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.plan.operations.map(op => op.action), ['delete']);
});

test('CLI rejects unsupported required constraints before creating state files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-cli-required-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'graph.json');
  const state = join(directory, 'state');
  const app = resource('app', 'simulator', {});
  const graph = infra('required').boundary({ id: 'secure', kind: 'security', requirements: [{ kind: 'isolation', mode: 'required' }] })
    .within('secure', app).synth();
  await writeFile(path, JSON.stringify(graph));
  await assert.rejects(execute(process.execPath, [cli, 'apply', path, '--state-dir', state]), /Unsupported required boundary enforcement/);
  await assert.rejects(access(state));
});

test('cleanup preserves namespaces with a valid newly synthesized graph envelope', () => {
  const ns = resource('namespace', 'kubernetes', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'fixture' } });
  const app = resource('app', 'kubernetes', { kind: 'Deployment' });
  const graph = infra('cleanup').boundary({ id: 'west', kind: 'region' }).start(ns).next(app).within('west', ns, app).synth();
  const saved: StackState = { version: 1, stack: graph.name, resources: Object.fromEntries(graph.resources.map(resource => [resource.id, { resource, fingerprint: 'fixture' }])) };
  const cleanup = cleanupStack(graph, saved) as typeof graph;
  assert.equal(cleanup.kind, 'infra-graph');
  assert.deepEqual(cleanup.resources.map(resource => resource.id), ['namespace']);
  assert.deepEqual(cleanup.memberships, [{ resourceId: 'namespace', boundaryId: 'west' }]);
  assert.notEqual(cleanup.digest, graph.digest);
});

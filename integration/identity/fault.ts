import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadIdentityTarget } from './target.ts';
import { createIdentityGraph } from './graph.ts';
import { identityEngine } from './engine.ts';

const action = process.argv[2];
if (!['directory-down', 'restore'].includes(action ?? '')) throw new Error('Usage: npm run identity:fault -- directory-down|restore [/path/to/target.json]');
const target = await loadIdentityTarget(process.argv[3]);
let includeNeo = false;
try { await access(join(target.directory, 'deployment.json')); includeNeo = true; } catch { /* identity-only preflight */ }
const graph = createIdentityGraph(target, { includeNeo, directoryEnabled: action === 'restore' });
const { engine } = identityEngine(target);
const plan = await engine.plan(graph);
if (plan.operations.some(operation => operation.resource.id !== 'identity-directory' && operation.action !== 'noop')) {
  throw new Error('A directory fault test may only change the owned directory resource');
}
const result = await engine.apply(graph);
await mkdir(join(target.directory, 'faults'), { recursive: true, mode: 0o700 });
await writeFile(join(target.directory, 'faults', result.runId + '.json'), JSON.stringify({ action, result }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ ok: result.ok, action, runId: result.runId, evidencePath: result.evidencePath,
  operations: result.plan.operations.map(operation => ({ id: operation.resource.id, action: operation.action })) }, null, 2));
if (!result.ok) process.exitCode = 1;

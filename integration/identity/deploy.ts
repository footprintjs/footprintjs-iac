import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadIdentityTarget } from './target.ts';
import { createIdentityGraph } from './graph.ts';
import { identityEngine } from './engine.ts';
import { command } from './command.ts';

const identityOnly = process.argv.includes('--identity-only');
const targetPath = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const target = await loadIdentityTarget(targetPath);
const graph = createIdentityGraph(target, { includeNeo: !identityOnly });
const { engine, recorder } = identityEngine(target);
const result = await engine.apply(graph);
await writeFile(join(target.directory, identityOnly ? 'identity-deployment.json' : 'deployment.json'), JSON.stringify({ graph, result, events: recorder.getEvents() }, null, 2) + '\n', { mode: 0o600 });
if (!result.ok) throw new Error(`Identity deployment failed; inspect private evidence ${result.evidencePath}`);
if (identityOnly) {
  const inspected = JSON.parse(await command('docker', ['inspect', target.providerName])) as { NetworkSettings: { Networks: { kind: { IPAddress: string } } } }[];
  target.providerAddress = inspected[0]!.NetworkSettings.Networks.kind.IPAddress;
  await writeFile(join(target.directory, 'target.json'), JSON.stringify(target, null, 2) + '\n', { mode: 0o600 });
  const latest = join(target.directory, '../latest.json');
  const current = JSON.parse(await readFile(latest, 'utf8')) as { id: string };
  if (current.id === target.id) await writeFile(latest, JSON.stringify(target, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify({ ok: true, runId: result.runId, context: target.context, namespace: target.namespace, evidencePath: result.evidencePath,
  actions: result.plan.operations.map(operation => ({ id: operation.resource.id, action: operation.action })) }, null, 2));

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadIdentityTarget } from './target.ts';
import { identityEngine } from './engine.ts';
import { FileStateStore } from '../../src/store.ts';
import { identityCleanupStack } from './cleanup-plan.ts';

if (!process.argv[2]) throw new Error('Usage: node integration/identity/cleanup.ts /path/to/identity/target.json');
const target = await loadIdentityTarget(process.argv[2]);
const { engine } = identityEngine(target);
const name = `neo-identity-${target.id}`;
const state = await new FileStateStore(target.stateDirectory).load(name);
const cleanup = identityCleanupStack(target, state);
const result = await engine.apply(cleanup, { prune: true });
await writeFile(join(target.directory, 'cleanup.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ ok: result.ok, runId: result.runId, namespaceRetained: cleanup.resources.length > 0,
  actions: result.plan.operations.map(operation => ({ id: operation.resource.id, action: operation.action })) }, null, 2));
if (!result.ok) process.exitCode = 1;

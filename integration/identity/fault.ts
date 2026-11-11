import { loadIdentityTarget } from './target.ts';
import { applyNeoIdentityFault } from './apply-fault.ts';
import type { NeoIdentityFaultAction } from './fault-graph.ts';

const selected = process.argv[2], action = selected === 'restore' ? 'directory-restore' : selected;
if (!['directory-down', 'directory-restore', 'provider-down', 'provider-restore', 'service-route-down', 'service-route-restore'].includes(action ?? '')) {
  throw Error('Usage: npm run identity:fault -- directory-down|restore|provider-down|provider-restore|service-route-down|service-route-restore [/path/to/target.json]');
}
const target = await loadIdentityTarget(process.argv[3]);
const { result } = await applyNeoIdentityFault(target, action as NeoIdentityFaultAction);
console.log(JSON.stringify({ ok: result.ok, action, runId: result.runId, evidencePath: result.evidencePath,
  operations: result.plan.operations.map(operation => ({ id: operation.resource.id, action: operation.action })) }, null, 2));
if (!result.ok) process.exitCode = 1;

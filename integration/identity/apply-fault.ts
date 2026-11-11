import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InfraEngine } from '../../src/engine.ts';
import { FileStateStore } from '../../src/store.ts';
import { KubernetesAdapter } from '../../src/providers/kubernetes.ts';
import { createDeploymentRecorder } from '../../src/progress/index.ts';
import type { Resource, ResourceAdapter, StateStore } from '../../src/types.ts';
import { canonical } from '../../src/util.ts';
import { IdentityFixtureAdapter } from './docker-adapter.ts';
import { createNeoIdentityFaultGraph, type NeoIdentityFaultAction } from './fault-graph.ts';
import { executeNeoIdentityFaultEffect } from './fault-effect.ts';
import { identityRoot, loadIdentityTarget, validateIdentityTarget, type IdentityTarget } from './target.ts';

/** Trusted host/test seams; callers of a dashboard cannot supply adapters, storage or selectors. */
export interface NeoIdentityFaultOptions {
  fixtureRoot?: string;
  loadTarget?: typeof loadIdentityTarget;
  adapters?: readonly ResourceAdapter[];
  store?: StateStore;
}

/** Reconcile a bounded owned outage/restoration through the normal durable FootPrint engine. */
export async function applyNeoIdentityFault(input: IdentityTarget, action: NeoIdentityFaultAction, options: NeoIdentityFaultOptions = {}) {
  const root = options.fixtureRoot ?? identityRoot, target = validateIdentityTarget(input, root);
  const loader = options.loadTarget ?? ((path?: string) => loadIdentityTarget(path, { root }));
  const admit = async () => {
    if (canonical(validateIdentityTarget(await loader(join(target.directory, 'target.json')), root)) !== canonical(target)) throw Error('Fault target admission failed');
  };
  await admit();
  const store = options.store ?? new FileStateStore(target.stateDirectory), stack = `neo-identity-${target.id}`;
  const inventory = await store.load(stack), { graph, resourceId } = createNeoIdentityFaultGraph(target, inventory, action);
  const selected = graph.resources.find(resource => resource.id === resourceId)!;
  const checkMutation = async (resource: Resource) => {
    await admit();
    if (resource.id !== resourceId || canonical(resource) !== canonical(selected)) throw Error('A fault test may only change its selected owned resource');
  };
  const adapters = options.adapters ?? [new IdentityFixtureAdapter(target.id, undefined, root),
    new KubernetesAdapter({ context: target.context, kubeconfig: target.kubeconfig, namespace: target.namespace })];
  const guarded = adapters.map((adapter): ResourceAdapter => ({ name: adapter.name, scope: adapter.scope, supportsSafeRetry: adapter.supportsSafeRetry,
    async observe(resource, context) { await admit(); return adapter.observe(resource, context); },
    async apply(resource, context) {
      await checkMutation(resource);
      const actual = await adapter.observe(resource, context);
      if (!actual.exists || actual.owned !== true || actual.physicalId !== inventory.resources[resourceId]!.physicalId) throw Error('Fault resource ownership changed before mutation');
      if (options.adapters) await adapter.apply(resource, context);
      else await executeNeoIdentityFaultEffect(target, resource, actual.physicalId!, context);
    },
    async remove() { throw Error('A connection fault test cannot remove resources'); },
    async waitReady(resource, context) { await admit(); await adapter.waitReady(resource, context); },
  }));
  const guardedStore: StateStore = { load: store.load.bind(store), save: store.save.bind(store), append: store.append.bind(store), saveEvidence: store.saveEvidence.bind(store),
    withLock: (name, work) => store.withLock(name, async () => {
      await admit();
      if (name !== stack || canonical(await store.load(stack)) !== canonical(inventory)) throw Error('Fault inventory changed before execution');
      return work();
    }) };
  const recorder = createDeploymentRecorder();
  const engine = new InfraEngine({ adapters: guarded, store: guardedStore, traceDirectory: join(target.directory, 'deployment-traces'), recorders: [recorder], chartObservers: [recorder] });
  const plan = await engine.plan(graph);
  if (plan.operations.some(operation => operation.resource.id !== resourceId && operation.action !== 'noop')
    || plan.operations.some(operation => !['noop', 'update', 'verify'].includes(operation.action))) throw Error('A fault test cannot repair unrelated resources or create replacements');
  const result = await engine.apply(graph), evidence = { action, resourceId, graph, result, events: recorder.getEvents() };
  const directory = join(target.directory, 'faults'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, result.runId + '.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  return evidence;
}

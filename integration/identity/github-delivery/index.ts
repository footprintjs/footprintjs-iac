import { join, resolve } from 'node:path';
import { DeliveryWorkflow } from '../../../src/delivery/workflow.ts';
import { FileDeliveryStore } from '../../../src/delivery/store.ts';
import type { DeliveryDefinition } from '../../../src/delivery/types.ts';
import { fingerprint } from '../../../src/util.ts';
import { loadIdentityTarget } from '../target.ts';
import { identityEngine } from '../engine.ts';
import { command } from '../command.ts';
import { readFile } from 'node:fs/promises';
import { prepareNeoDeliveryMaster } from './baseline.ts';
import { neoDeliveryBuildAdapters, neoDeliveryRecipe } from './build.ts';
import { neoDeliveryDeploymentAdapter } from './deployment.ts';
import { neoDeliveryTarget, sameNeoDeliveryTarget } from './target.ts';
import { lockNeoDeliveryTarget } from './lock.ts';
import type { NeoGithubDeliveryOptions, NeoDeliveryObservation } from './types.ts';

export type { NeoGithubDeliveryOptions, NeoDeliveryBaseline, NeoDeliveryObservation } from './types.ts';
export { neoDeliveryTarget, readNeoDeliveryCandidate, neoDeliveryArtifacts } from './target.ts';
export { neoDeliveryRecipe } from './build.ts';
export { restoreNeoDeliveryForward, neoDeliveryForwardArgs } from './forward.ts';

/** Neo is a consumer of the generic delivery ports; its fixed host owns all local paths and commands. */
export async function createNeoGithubDelivery(options: NeoGithubDeliveryOptions) {
  const targetPath = resolve(options.targetPath);
  const target = await (options.loadTarget ?? loadIdentityTarget)(targetPath);
  if (targetPath !== join(target.directory, 'target.json')) throw Error('Pin the canonical Neo target for this delivery');
  try { await (options.buildOptions?.runner ?? command)('kind', ['version']); }
  catch { throw Error('Neo local package storage requires kind on this host’s PATH before starting a GitHub delivery'); }
  const id = options.id ?? 'neo-github-' + target.id;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) throw Error('Choose a fixed Neo delivery ID');
  const directory = join(target.directory, 'deliveries', id);
  const listeners = new Set<(event: NeoDeliveryObservation) => void>();
  const emit = (event: NeoDeliveryObservation) => {
    for (const listener of listeners) try { listener(event); } catch { /* A viewer cannot affect delivery. */ }
  };
  const prepared = await prepareNeoDeliveryMaster(target, options.source.repository, identityEngine(target), emit);
  const recipe = await neoDeliveryRecipe();
  const definition: DeliveryDefinition = { id, label: 'Neo from GitHub', target: neoDeliveryTarget(target),
    source: options.source, recipe,
    configurationDigest: fingerprint({ adapter: 'neo-local-github-delivery-v2-assessed', target: neoDeliveryTarget(target),
      recipe, source: options.source, verification: 'three-connections-seven-identity-checks' }) };
  const { build, artifacts } = neoDeliveryBuildAdapters({ ...options, targetPath }, target, recipe);
  const nativeWorkflow = new DeliveryWorkflow({ definition, store: new FileDeliveryStore(directory), adapters: {
    source: options.sourceAdapter, build, artifacts,
    deployment: neoDeliveryDeploymentAdapter({ ...options, targetPath }, target, directory, prepared.workflow, emit),
  } });
  const workflow = lockNeoDeliveryTarget(target.directory, nativeWorkflow, async () => {
    if (!sameNeoDeliveryTarget(JSON.parse(await readFile(targetPath, 'utf8')), target)) {
      throw Error('The running Neo version changed; reopen and bind a new delivery before getting source');
    }
  });
  return { workflow, target, directory, baseline: prepared.baseline,
    master: prepared.workflow,
    subscribe(listener: (event: NeoDeliveryObservation) => void): () => void {
      if (typeof listener !== 'function') throw Error('A Neo delivery listener must be callable');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  };
}

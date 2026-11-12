import { join, resolve } from 'node:path';
import { freeze, identifier, jsonCopy } from '../../src/graph/data.ts';
import { ResourceFlowAdapterError, type ConnectionDetails, type ResourceHandle } from '../../src/resource-flow/index.ts';
import { FileResourceFlowStore, ResourceFlowWorkflow } from '../../src/resource-flow/node.ts';
import { canonical, fingerprint } from '../../src/util.ts';
import { createNeoAcquisitionGraph } from './create-acquisition-graph.ts';
import { createNeoConsumerGraph } from './create-consumer-graph.ts';
import { identityEngine } from './engine.ts';
import { createIdentityGraph } from './graph.ts';
import { loadIdentityTarget, type IdentityTarget } from './target.ts';
import { assertNeoFlowDetails, neoFlowProfileId, resolveNeoFlowDetails } from './resource-flow-details.ts';
import { ensureNeoFlowForward } from './resource-flow-forward.ts';
import { applyNeoFlowGraph } from './resource-flow-native.ts';
import { neoFlowPhysicalId, neoFlowTargetScope, observeNeoFlowIdentity, type NeoFlowIdentityObservation } from './resource-flow-observation.ts';
import { verifyNeoResourceFlow, type NeoFlowVerificationOptions } from './resource-flow-verify.ts';

export interface NeoResourceFlowOptions { mode: 'create' | 'existing'; details?: 'automatic' | 'human'; id?: string }
/** Fixed composition/test seams. HTTP input never chooses a target, transport, command or secret. */
export interface NeoResourceFlowDependencies extends NeoFlowVerificationOptions {
  loadTarget?: typeof loadIdentityTarget;
  engine?: typeof identityEngine;
  observe?: (target: IdentityTarget) => Promise<NeoFlowIdentityObservation>;
  discoveryFetch?: typeof fetch;
  ensureForward?: typeof ensureNeoFlowForward;
}

/** Neo is a consumer of the generic base workflow, with no Neo branches in its engine or stages. */
export async function createNeoResourceFlow(targetPath: string, options: NeoResourceFlowOptions,
  dependencies: NeoResourceFlowDependencies = {}) {
  const loader = dependencies.loadTarget ?? loadIdentityTarget;
  const target = freeze(jsonCopy(await loader(resolve(targetPath))) as unknown as IdentityTarget);
  if (resolve(targetPath) !== join(target.directory, 'target.json')) throw Error('Pin the prepared identity target.json path');
  if (!['create', 'existing'].includes(options.mode) || (options.details !== undefined && !['automatic', 'human'].includes(options.details))) {
    throw Error('Choose Create or Find, with automatic or human connection details');
  }
  const input = options.details ?? 'automatic';
  const id = identifier(options.id ?? `neo-${options.mode}-${input}`, 'Neo resource flow');
  const directory = join(target.directory, 'resource-flows', id);
  const scope = neoFlowTargetScope(target), resourceId = 'neo-identity-' + target.id;
  const acquisitionGraph = createNeoAcquisitionGraph(target), consumerGraph = createNeoConsumerGraph(target);
  const graph = createIdentityGraph(target, { includeNeo: true });
  const { engine, recorder } = (dependencies.engine ?? identityEngine)(target);
  const observe = dependencies.observe ?? (selected => observeNeoFlowIdentity(selected, { loadTarget: loader }));
  const find = async (): Promise<ResourceHandle> => {
    const selected = await loader(targetPath);
    if (canonical(selected) !== canonical(target)) throw Error('The prepared Neo connection target changed');
    const observation = await observe(target);
    if (!observation.directory.running || !observation.provider.running) throw Error('The selected identity services are unavailable');
    return { id: resourceId, kind: 'identity-service', scope, physicalId: neoFlowPhysicalId(observation) };
  };
  const validate = async (resource: ResourceHandle, details?: ConnectionDetails) => {
    const current = await find();
    if (current.id !== resource.id || current.kind !== resource.kind || current.scope !== resource.scope || current.physicalId !== resource.physicalId) {
      throw Error('The selected identity services were replaced after acquisition');
    }
    if (details) assertNeoFlowDetails(target, resource, details);
  };
  const workflow = new ResourceFlowWorkflow({
    definition: { id, resourceId, label: options.mode === 'create' ? 'Create identity and connect Neo' : 'Find identity and connect Neo',
      mode: options.mode, target: { id: target.id, scope },
      configurationDigest: fingerprint({ graph: graph.digest, details: input, wrapper: 'neo-identity-resource-flow-v1' }) },
    store: new FileResourceFlowStore(directory), profiles: [{ id: neoFlowProfileId(target), label: 'Prepared Neo sign-in service' }],
    adapters: {
      async create() {
        const selected = await loader(targetPath);
        if (canonical(selected) !== canonical(target)) throw Error('The prepared Neo connection target changed');
        const result = await applyNeoFlowGraph(engine, recorder, acquisitionGraph, directory, 'acquire');
        return { ...await find(), receipt: { id: 'neo-identity-created', runId: result.runId, evidencePath: result.evidencePath } };
      },
      find,
      async resolveDetails(resource, profileId) {
        return resolveNeoFlowDetails(target, resource, profileId, input, dependencies.discoveryFetch);
      },
      validate,
      async connect(resource, details) {
        assertNeoFlowDetails(target, resource, details);
        const connected = createNeoConsumerGraph(target, details);
        if (connected.digest !== consumerGraph.digest) throw Error('Resolved connection details changed the pinned consumer configuration');
        const result = await applyNeoFlowGraph(engine, recorder, connected, directory, 'connect');
        const receipt = { id: 'neo-consumer-connected', runId: result.runId, evidencePath: result.evidencePath };
        try { await (dependencies.ensureForward ?? ensureNeoFlowForward)(target); }
        catch { throw new ResourceFlowAdapterError('consumer-access-unavailable', receipt); }
        return receipt;
      },
      async verify(resource, details) {
        await validate(resource, details);
        const result = await verifyNeoResourceFlow(target, directory, dependencies);
        try { await validate(resource, details); }
        catch { throw new ResourceFlowAdapterError('identity-changed-during-verification', result.receipts?.[0]); }
        return result;
      },
    },
  });
  return { workflow, target, directory, graph, acquisitionGraph, consumerGraph, profileId: neoFlowProfileId(target) };
}

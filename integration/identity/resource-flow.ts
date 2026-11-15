import { join, resolve } from 'node:path';
import { freeze, identifier, jsonCopy } from '../../src/graph/data.ts';
import { ResourceFlowAdapterError, type ConnectionDetails, type ResourceHandle, type ResourceFlowContext } from '../../src/resource-flow/index.ts';
import { FileResourceFlowStore, ResourceFlowWorkflow } from '../../src/resource-flow/node.ts';
import { canonical, fingerprint } from '../../src/util.ts';
import { NeoResourceFlowFeed } from './resource-flow-feed.ts';
import { createNeoAcquisitionGraph } from './create-acquisition-graph.ts';
import { createNeoConsumerGraph } from './create-consumer-graph.ts';
import { identityEngine } from './engine.ts';
import { createIdentityGraph } from './graph.ts';
import { loadIdentityTarget, type IdentityTarget } from './target.ts';
import { assertNeoFlowDetails, neoFlowProfileId, resolveNeoFlowDetails } from './resource-flow-details.ts';
import { ensureNeoFlowForward } from './resource-flow-forward.ts';
import { applyNeoFlowGraph } from './resource-flow-native.ts';
import { neoFlowPhysicalId, neoFlowTargetScope, observeNeoFlowIdentity, type NeoFlowIdentityObservation } from './resource-flow-observation.ts';
import { checkNeoFlowConnections, checkNeoFlowIdentity, verifyNeoResourceFlow, type NeoFlowVerificationOptions } from './resource-flow-verify.ts';
import { assertNeoRegisteredConnection, assertNeoRegisteredConnectionReference, createNeoConnectionProfiles, neoRegisteredConnectionDetails,
  type NeoConnectionProfileStores } from './connection-profiles.ts';
import { applyNeoIdentityFault } from './apply-fault.ts';

export interface NeoResourceFlowOptions { mode: 'create' | 'existing'; details?: 'automatic' | 'human'; profiles?: 'prepared' | 'user'; id?: string }
/** Fixed composition/test seams. HTTP input never chooses a target, transport, command or secret. */
export interface NeoResourceFlowDependencies extends NeoFlowVerificationOptions {
  loadTarget?: typeof loadIdentityTarget;
  engine?: typeof identityEngine;
  observe?: (target: IdentityTarget) => Promise<NeoFlowIdentityObservation>;
  discoveryFetch?: typeof fetch;
  ensureForward?: typeof ensureNeoFlowForward;
  connectionProfileStores?: NeoConnectionProfileStores;
  fault?: typeof applyNeoIdentityFault;
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
  if (options.profiles !== undefined && !['prepared', 'user'].includes(options.profiles)
    || options.profiles === 'user' && options.mode !== 'existing') throw Error('User-entered profiles connect an existing identity service');
  const userProfiles = options.profiles === 'user';
  const connectionProfiles = userProfiles ? await createNeoConnectionProfiles(target, {
    requestFetch: dependencies.discoveryFetch, stores: dependencies.connectionProfileStores,
  }) : undefined;
  const input = options.details ?? 'automatic';
  const id = identifier(options.id ?? `neo-${options.mode}-${input}`, 'Neo resource flow');
  const directory = join(target.directory, 'resource-flows', id);
  const lifecycleStore = new FileResourceFlowStore(directory);
  const scope = neoFlowTargetScope(target), resourceId = 'neo-identity-' + target.id;
  const acquisitionGraph = createNeoAcquisitionGraph(target), consumerGraph = createNeoConsumerGraph(target);
  const graph = createIdentityGraph(target, { includeNeo: true });
  const { engine, recorder } = (dependencies.engine ?? identityEngine)(target);
  const observation = new NeoResourceFlowFeed(target, directory, { acquire: acquisitionGraph, connect: consumerGraph, system: graph });
  const observe = dependencies.observe ?? (selected => observeNeoFlowIdentity(selected, { loadTarget: loader }));
  const find = async (context: ResourceFlowContext): Promise<ResourceHandle> => {
    const selected = await loader(targetPath);
    if (canonical(selected) !== canonical(target)) throw Error('The prepared Neo connection target changed');
    if (connectionProfiles) {
      if (!context.profileId) throw Error('Select an existing connection profile before finding its service');
      // Resolve the user's saved address and credentials before discovery, without mutating the source.
      const { profile } = await connectionProfiles.resolve(context.profileId);
      neoRegisteredConnectionDetails(target, { id: resourceId, kind: 'identity-service', scope, physicalId: 'pending' }, profile);
    }
    const observed = await observe(target);
    if (!observed.directory.running || !observed.provider.running) throw Error('The selected identity services are unavailable');
    await observation.observeSource(observed, context);
    return { id: resourceId, kind: 'identity-service', scope, physicalId: neoFlowPhysicalId(observed) };
  };
  const validate = async (resource: ResourceHandle, details: ConnectionDetails | undefined, context: ResourceFlowContext) => {
    const current = await find(context);
    if (current.id !== resource.id || current.kind !== resource.kind || current.scope !== resource.scope || current.physicalId !== resource.physicalId) {
      throw Error('The selected identity services were replaced after acquisition');
    }
    if (details) await assertDetails(resource, details, context.profileId);
  };
  const assertDetails = async (resource: ResourceHandle, details: ConnectionDetails, selectedProfileId?: string) => {
    if (connectionProfiles) await assertNeoRegisteredConnection(connectionProfiles, target, resource, details, selectedProfileId);
    else assertNeoFlowDetails(target, resource, details);
  };
  const workflow = new ResourceFlowWorkflow({
    definition: { id, resourceId, label: options.mode === 'create' ? 'Create identity and connect Neo' : 'Find identity and connect Neo',
      mode: options.mode, target: { id: target.id, scope },
      configurationDigest: fingerprint({ graph: graph.digest, details: input, wrapper: 'neo-identity-resource-flow-v1',
        ...(userProfiles ? { profiles: 'user-v1' } : {}) }) },
    store: lifecycleStore,
    profiles: connectionProfiles ? async () => (await connectionProfiles.list()).map(profile => ({ id: profile.id, label: profile.label }))
      : [{ id: neoFlowProfileId(target), label: 'Prepared Neo sign-in service' }],
    ...(connectionProfiles ? { profileCatalogId: 'neo-existing-identity-' + target.id, requireProfileAtStart: true } : {}),
    adapters: {
      async create(context) {
        const selected = await loader(targetPath);
        if (canonical(selected) !== canonical(target)) throw Error('The prepared Neo connection target changed');
        observation.beginApply('acquire', context);
        const result = await applyNative('acquire', acquisitionGraph, context);
        return { ...await find(context), receipt: { id: 'neo-identity-created', runId: result.runId, evidencePath: result.evidencePath } };
      },
      find,
      async resolveDetails(resource, profileId, context) {
        if (connectionProfiles) {
          if (profileId === undefined && input === 'human') return undefined;
          const selectedId = profileId ?? context.profileId;
          if (!selectedId || context.profileId && context.profileId !== selectedId) throw Error('The selected existing connection profile changed');
          return neoRegisteredConnectionDetails(target, resource, (await connectionProfiles.resolve(selectedId)).profile);
        }
        return resolveNeoFlowDetails(target, resource, profileId, input, dependencies.discoveryFetch);
      },
      validate,
      async connect(resource, details, context) {
        await assertDetails(resource, details, context.profileId);
        const connected = createNeoConsumerGraph(target, details);
        if (connected.digest !== consumerGraph.digest) throw Error('Resolved connection details changed the pinned consumer configuration');
        observation.beginApply('connect', context);
        const result = await applyNative('connect', connected, context);
        const receipt = { id: 'neo-consumer-connected', runId: result.runId, evidencePath: result.evidencePath };
        try { await (dependencies.ensureForward ?? ensureNeoFlowForward)(target); }
        catch { throw new ResourceFlowAdapterError('consumer-access-unavailable', receipt); }
        return receipt;
      },
      async verify(resource, details, _connection, context) {
        await validate(resource, details, context);
        const result = await verifyNeoResourceFlow(target, directory, dependencies, checkObserver(context, 'verify'));
        await observation.flush();
        try { await validate(resource, details, context); }
        catch { throw new ResourceFlowAdapterError('identity-changed-during-verification', result.receipts?.[0]); }
        return result;
      },
    },
  });
  function checkObserver(context: ResourceFlowContext, purpose: 'verify' | 'recheck') {
    const correlation = { executionId: context.executionId, definitionDigest: context.definitionDigest, purpose };
    return { connections: (snapshot: import('../../src/connections/types.ts').ConnectionSnapshot, result?: import('../../src/connections/types.ts').ConnectionRunResult) => observation.captureConnections(correlation, snapshot, result),
      identity: (snapshot: import('../../src/identity/types.ts').IdentitySnapshot, result?: import('../../src/identity/types.ts').IdentityRunResult) => observation.captureIdentity(correlation, snapshot, result) };
  }
  async function applyNative(phase: 'acquire' | 'connect', selected: typeof graph, context: ResourceFlowContext) {
    try {
      const result = await applyNeoFlowGraph(engine, recorder, selected, directory, phase);
      await observation.completeApply(phase, context, recorder.getSnapshot(), result); return result;
    } catch (error) {
      if (error instanceof ResourceFlowAdapterError && error.receipt?.runId) {
        const saved = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(directory, 'infra', error.receipt!.runId + '.json'), 'utf8')));
        await observation.completeApply(phase, context, recorder.getSnapshot(), saved.result);
      }
      throw error;
    }
  }
  let activeOperation: 'recheck' | 'fault' | undefined;
  async function completedBinding() {
    const state = await workflow.snapshot();
    if (state.status !== 'passed' || !state.executionId || !state.resource || !state.details) throw Error('Complete this Neo resource flow before rechecking or testing an outage');
    const selected = await loader(targetPath);
    if (canonical(selected) !== canonical(target)) throw Error('The prepared Neo connection target changed');
    const measured = await (dependencies.observe ?? (selected => observeNeoFlowIdentity(selected, { loadTarget: loader, allowStopped: true })))(target);
    if (neoFlowPhysicalId(measured) !== state.resource.physicalId || state.resource.scope !== scope || state.resource.id !== resourceId) {
      throw Error('The selected identity services were replaced after acquisition');
    }
    if (connectionProfiles) await assertNeoRegisteredConnectionReference(connectionProfiles, target, state.resource, state.details, state.selectedProfileId);
    else assertNeoFlowDetails(target, state.resource, state.details);
    return state;
  }
  function recheck(kind: 'connections'): Promise<import('../../src/connections/types.ts').ConnectionRunResult>;
  function recheck(kind: 'identity'): Promise<import('../../src/identity/types.ts').IdentityRunResult>;
  async function recheck(kind: 'connections' | 'identity') {
    if (activeOperation) throw Error('A Neo observation or outage test is already running');
    activeOperation = 'recheck';
    try {
      const state = await completedBinding();
      const context = { executionId: state.executionId!, definitionDigest: state.definitionDigest, operationId: fingerprint(state.executionId) };
      return await (kind === 'connections' ? checkNeoFlowConnections : checkNeoFlowIdentity)(target, directory, dependencies, checkObserver(context, 'recheck'));
    } finally { try { await observation.flush(); } finally { activeOperation = undefined; } }
  }
  async function fault(action: 'provider-down' | 'provider-restore') {
    if (activeOperation) throw Error('A Neo observation or outage test is already running');
    activeOperation = 'fault';
    try {
      const state = await completedBinding();
      const result = await (dependencies.fault ?? applyNeoIdentityFault)(target, action, { loadTarget: loader });
      // A host action and its following observations are separate runs. Preserve correlation without inventing a causal edge.
      let correlationCaptureError: string | undefined;
      try {
        await lifecycleStore.writeJson(join(directory, 'fault-' + result.result.runId + '.json'), {
          version: 1, kind: 'owned-identity-fault-reference', action, resourceId: result.resourceId,
          executionId: state.executionId, definitionDigest: state.definitionDigest, selectedProfileId: state.selectedProfileId ?? null,
          acquiredPhysicalId: state.resource!.physicalId, ok: result.result.ok,
          receipt: { id: 'neo-owned-' + action, runId: result.result.runId, evidencePath: result.result.evidencePath },
          attribution: 'Recorded owned test action; subsequent checks independently measure symptoms. External root cause is not established by cross-run ordering.',
        });
      } catch { correlationCaptureError = 'The flow correlation reference could not be retained. The native action receipt remains authoritative.'; }
      return { ...result, correlationCaptureError };
    } finally { activeOperation = undefined; }
  }
  await observation.attach(workflow, recorder);
  return { workflow, observation, recheckConnections: () => recheck('connections'), recheckIdentity: () => recheck('identity'),
    pauseIdentityService: () => fault('provider-down'), restoreIdentityService: () => fault('provider-restore'),
    target, directory, graph, acquisitionGraph, consumerGraph, profileId: neoFlowProfileId(target), connectionProfiles };
}

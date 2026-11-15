import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FlowchartCheckpoint } from 'footprintjs';
import { jsonCopy } from '../graph/data.ts';
import { identifier, readHostRef } from '../platform-access/data.ts';
import { readBootstrapIntent, readBootstrapRevalidation } from '../platform-bootstrap/data.ts';
import { readConnectionDetails, readFlowReceipt, readResourceFlowDefinition, readVerificationResult } from '../resource-flow/data.ts';
import { ResourceFlowProfileCatalog } from '../resource-flow/profile-catalog.ts';
import { FileResourceFlowStore } from '../resource-flow/store.ts';
import { ResourceFlowWorkflow, type ResourceFlowOptions } from '../resource-flow/workflow.ts';
import { canonical, fingerprint } from '../util.ts';
import { readPlatformBootstrapState } from './data.ts';
import { runPlatformNative } from './native-run.ts';
import { observeCluster } from './publication-stages.ts';
import { verifyPlatformStateEvidence } from './recording.ts';
import { admitFreshFacts, admitMutationHosts, contextFor, discoverFacts, type PlatformStages } from './stages.ts';
import { FilePlatformBootstrapStore, type StoredPlatformBootstrap } from './store.ts';
import type { PlatformBootstrapState, PlatformWorkflowOptions, PlatformWorkflowState } from './types.ts';

/** Server access remains its own existing-resource connection flow with its own immutable profile. */
export function createHostAccessWorkflow(options: ResourceFlowOptions): ResourceFlowWorkflow {
  if (readResourceFlowDefinition(options.definition).mode !== 'existing' || options.adapters.create !== undefined) throw Error('Host access must find an existing admitted server');
  return new ResourceFlowWorkflow(options);
}

/** Composes native bootstrap subflows and the existing connection ResourceFlow, not another engine. */
export class PlatformClusterWorkflow {
  private readonly options: PlatformWorkflowOptions;
  private readonly store: FilePlatformBootstrapStore;
  private readonly catalog: ResourceFlowProfileCatalog;
  private readonly bindingDigest: string;
  constructor(options: PlatformWorkflowOptions) {
    const definition = readResourceFlowDefinition(options.definition), intent = readBootstrapIntent(options.intent);
    const hosts = (jsonCopy(options.hosts) as unknown[]).map(readHostRef);
    if (definition.mode !== intent.mode || definition.resourceId !== intent.id || definition.target.scope !== options.lifecycle.scope
      || !Array.isArray(hosts) || hosts.length > 64 || new Set(hosts.map(host => host.id)).size !== hosts.length
      || intent.topology.nodes.some(node => !hosts.some(host => host.id === node.hostId))
      || hosts.length > 0 && (!options.discovery?.id || typeof options.discovery.inspect !== 'function') || !options.lifecycle?.id
      || ['assess', 'revalidate', 'executeAction', 'find', 'publishAccess', 'verify'].some(name => typeof options.lifecycle[name as keyof typeof options.lifecycle] !== 'function')
      || typeof options.resolveDetails !== 'function' || typeof options.connect !== 'function'
      || options.maxFactAgeMs !== undefined && (!Number.isSafeInteger(options.maxFactAgeMs) || options.maxFactAgeMs < 1000 || options.maxFactAgeMs > 300000)) throw Error('Configure admitted platform workflow ports and host references');
    const discovery = options.discovery ? Object.freeze({ id: identifier(options.discovery.id), inspect: options.discovery.inspect.bind(options.discovery) }) : undefined;
    const lifecycle = Object.freeze({ id: identifier(options.lifecycle.id), scope: identifier(options.lifecycle.scope),
      assess: options.lifecycle.assess.bind(options.lifecycle), revalidate: options.lifecycle.revalidate.bind(options.lifecycle),
      executeAction: options.lifecycle.executeAction.bind(options.lifecycle), find: options.lifecycle.find.bind(options.lifecycle),
      publishAccess: options.lifecycle.publishAccess.bind(options.lifecycle), verify: options.lifecycle.verify.bind(options.lifecycle) });
    this.catalog = new ResourceFlowProfileCatalog(options.profiles, options.profileCatalogId);
    this.options = { ...options, definition, intent, hosts, discovery, lifecycle,
      profiles: typeof options.profiles === 'function' ? options.profiles : this.catalog.identity && 'profiles' in this.catalog.identity ? this.catalog.identity.profiles : [],
      resolveDetails: options.resolveDetails.bind(options), connect: options.connect.bind(options),
      ...(options.recorders ? { recorders: [...options.recorders] } : {}) };
    this.store = new FilePlatformBootstrapStore(join(options.directory, 'bootstrap'));
    this.bindingDigest = fingerprint({ definition, intent, hosts, discoveryId: discovery?.id ?? 'no-host-discovery',
      lifecycleId: lifecycle.id, lifecycleScope: lifecycle.scope, catalog: this.catalog.identity, maxFactAgeMs: options.maxFactAgeMs ?? 30000 });
  }
  private initial(): PlatformBootstrapState {
    return { version: 1, kind: 'platform-bootstrap-state', bindingDigest: this.bindingDigest, executionId: null, status: 'idle', actions: [], recordings: [] };
  }
  private config(state: PlatformBootstrapState): PlatformStages {
    return { options: this.options, state, store: this.store, profileIds: async () => (await this.profileChoices()).map(profile => profile.id) };
  }
  private async profileChoices() {
    try { return (await this.catalog.list()).filter(profile => !this.options.hosts.some(host => host.profileId === profile.id)); }
    catch { throw Error('platform-profile-catalog-unavailable'); }
  }
  private async load(): Promise<StoredPlatformBootstrap> {
    const loaded = await this.store.load() ?? { version: 1 as const, state: this.initial() };
    if (loaded.state.bindingDigest !== this.bindingDigest) throw Error('Platform bindings changed; inspect the existing execution');
    if (loaded.state.plan && (loaded.state.plan.adapterId !== this.options.lifecycle.id || loaded.state.plan.scope !== this.options.lifecycle.scope
      || loaded.state.plan.intentDigest !== fingerprint(this.options.intent))) throw Error('Platform plan differs from its host binding');
    await verifyPlatformStateEvidence(loaded.state, this.store.directory);
    return loaded;
  }
  private connection(state: PlatformBootstrapState): ResourceFlowWorkflow {
    if (state.status !== 'passed' || !state.resource || !state.accessProfileId || !state.plan) throw Error('Verified bootstrap evidence is required before connecting a workload');
    const config = this.config(state), lifecycle = this.options.lifecycle;
    const validate = async () => {
      await observeCluster(config, 'connection-identity');
      const facts = await discoverFacts(config, 'connection-revalidate');
      admitFreshFacts(config, facts);
      admitMutationHosts(config, state.plan!, facts);
      const result = readBootstrapRevalidation(await lifecycle.revalidate(state.plan!, this.options.intent, facts, contextFor(config, 'connection-revalidate')));
      if (!result.valid || result.planDigest !== state.plan!.digest) throw Error('Platform connection preflight no longer holds');
    };
    return new ResourceFlowWorkflow({
      definition: { ...this.options.definition, id: 'platform-connection-' + fingerprint(this.options.definition.id).slice(0, 32), mode: 'existing',
        configurationDigest: fingerprint({ configurationDigest: this.options.definition.configurationDigest, planDigest: state.plan.digest, resource: state.resource }) },
      store: new FileResourceFlowStore(join(this.options.directory, 'connection')), profiles: () => this.profileChoices(),
      profileCatalogId: this.options.profileCatalogId ?? 'platform-profiles-' + fingerprint(this.catalog.identity).slice(0, 32), requireProfileAtStart: true,
      adapters: {
        find: async () => observeCluster(config, 'connection-find'),
        resolveDetails: async (resource, selected, context) => {
          const profileId = selected ?? state.accessProfileId!;
          if (profileId !== state.accessProfileId || this.options.hosts.some(host => host.profileId === profileId)) throw Error('Kubernetes access cannot reuse or replace a management profile');
          const details = await this.options.resolveDetails(resource, profileId, context);
          return details === undefined ? undefined : readConnectionDetails(details);
        },
        validate,
        connect: async (resource, details, context) => {
          await validate(); // Point-in-time revalidation is repeated immediately before configuration effects.
          return readFlowReceipt(await this.options.connect(resource, details, context));
        },
        verify: async resource => readVerificationResult(await lifecycle.verify(resource, state.accessProfileId!, contextFor(config, 'connection-verify'))),
      }, ...(this.options.recorders ? { recorders: this.options.recorders } : {}),
    });
  }
  private async snapshotFrom(state: PlatformBootstrapState): Promise<PlatformWorkflowState> {
    const bootstrap = readPlatformBootstrapState(state);
    if (bootstrap.status !== 'passed') return { version: 1, kind: 'platform-workflow-state', status: bootstrap.status, bootstrap };
    const connection = await this.connection(bootstrap).snapshot();
    return { version: 1, kind: 'platform-workflow-state', status: connection.status === 'idle' ? 'running' : connection.status, bootstrap, connection };
  }
  async snapshot(): Promise<PlatformWorkflowState> { return this.snapshotFrom((await this.load()).state); }
  start(): Promise<PlatformWorkflowState> {
    return this.store.withLock(async () => {
      const envelope = await this.load(), state = structuredClone(envelope.state);
      if (state.status === 'idle') {
        state.executionId = randomUUID(); state.status = 'running'; await this.store.save({ version: 1, state });
        const config = this.config(state);
        await runPlatformNative(config, 'assessment');
        if (state.status === 'running' && state.plan?.disposition !== 'blocked') await runPlatformNative(config, 'execution');
      } else if (state.status !== 'passed') {
        throw Error('This platform execution already started; use its exact pause or inspect retained uncertain outcomes');
      }
      if (state.status === 'passed') {
        const connection = this.connection(state), current = await connection.snapshot();
        if (current.status === 'idle') await connection.start({ profileId: state.accessProfileId! });
      }
      return this.snapshotFrom(state);
    });
  }
  resume(input: { pauseToken: string; profileId: string }): Promise<PlatformWorkflowState> {
    return this.store.withLock(async () => {
      const answer = jsonCopy(input) as unknown as { pauseToken: string; profileId: string };
      if (!answer || Object.keys(answer).sort().join(',') !== 'pauseToken,profileId' || typeof answer.pauseToken !== 'string' || !/^[a-f0-9]{64}$/.test(answer.pauseToken)
        || typeof answer.profileId !== 'string') throw Error('Choose the exact pending platform pause and immutable profile');
      const envelope = await this.load(), state = structuredClone(envelope.state);
      if (state.status === 'passed') {
        await this.connection(state).resume(answer); return this.snapshotFrom(state);
      }
      const checkpoint = envelope.checkpoint;
      if (state.status !== 'paused' || state.pause?.token !== answer.pauseToken || !checkpoint
        || !(await this.profileChoices()).some(profile => profile.id === answer.profileId) || this.options.hosts.some(host => host.profileId === answer.profileId)) throw Error('The pending platform pause or selected profile is stale');
      this.admitCheckpoint(checkpoint, state);
      delete state.pause; delete state.errorCode; state.status = 'running';
      // Consume the answer before native resume; a crash retains uncertainty and cannot repeat installation.
      await this.store.save({ version: 1, state });
      await runPlatformNative(this.config(state), 'execution', checkpoint, answer.profileId);
      if (readPlatformBootstrapState(state).status === 'passed') await this.connection(state).start({ profileId: state.accessProfileId! });
      return this.snapshotFrom(state);
    });
  }
  private admitCheckpoint(checkpoint: FlowchartCheckpoint, state: PlatformBootstrapState) {
    const shared = checkpoint.sharedState;
    if (checkpoint.pausedStageId !== 'publish-access' || checkpoint.pausedBy !== 'interrupt' || checkpoint.subflowPath.length
      || checkpoint.subflowStates && Object.keys(checkpoint.subflowStates).length || !shared || shared.bindingDigest !== this.bindingDigest
      || shared.executionId !== state.executionId || canonical(shared.plan) !== canonical(state.plan) || canonical(shared.resource) !== canonical(state.resource)
      || shared.awaitingProfile !== true || shared.accessProfileId !== undefined || shared.verification !== undefined
      || checkpoint.pausedExecution?.runId !== state.recordings.at(-1)?.runId || state.actions.some(action => action.status !== 'completed')
      || state.publicationStatus !== 'completed') throw Error('The native checkpoint differs from this platform pause');
    const allowed = new Set(['bindingDigest', 'executionId', 'intent', 'hosts', 'plan', 'resource', 'awaitingProfile']);
    for (const action of state.actions) for (const prefix of ['facts:', 'revalidation:', 'intent:', 'receipt:']) allowed.add(prefix + action.id);
    if (Object.keys(shared).some(key => !allowed.has(key)) || canonical(shared.intent) !== canonical(this.options.intent) || canonical(shared.hosts) !== canonical(this.options.hosts)) throw Error('The platform checkpoint contains unsupported data');
    for (const action of state.actions) if (canonical(shared['receipt:' + action.id]) !== canonical(action.receipt)) throw Error('The platform checkpoint lost an action receipt');
  }
}

export function createPlatformClusterWorkflow(options: PlatformWorkflowOptions): PlatformClusterWorkflow { return new PlatformClusterWorkflow(options); }

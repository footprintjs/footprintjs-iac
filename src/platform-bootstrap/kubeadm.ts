import { canonical, fingerprint } from '../util.ts';
import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import type { HostFactsSnapshot } from '../platform-access/types.ts';
import type { ResourceHandle, VerificationResult } from '../resource-flow/types.ts';
import { descriptors, registerKubeadmConfiguration, type KubeadmClusterAdapterOptions, type RegisteredKubeadmConfiguration } from './kubeadm-config.ts';
import { kubeadmCapabilities, preparationEvidenceDigest } from './kubeadm-assessment.ts';
import { inspectCluster, publishClusterAccess, sameCluster, verifyClusterConnection } from './connection.ts';
import { identifier, normalizedPlatformVersion, readBootstrapActionReceipt, readBootstrapContext, readBootstrapIntent, readBootstrapPlan, readBootstrapRevalidation } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';
import { KUBEADM_ACTION_COMPLETE } from './kubeadm-actions.ts';
import { assessBootstrapStrategy } from './strategy.ts';
import type { BootstrapActionReceipt, BootstrapContext, BootstrapIntent, BootstrapPlan, BootstrapRevalidation, ClusterLifecycleAdapter, ClusterObservation, PublishedClusterAccess } from './types.ts';

/** Creates one control-plane plus declared workers through approved kubeadm/CNI actions.
 * Invoke through PlatformClusterWorkflow: durable per-action intent is the workflow's responsibility.
 */
export class KubeadmClusterAdapter implements ClusterLifecycleAdapter {
  readonly id: string; readonly scope: string;
  private readonly config: RegisteredKubeadmConfiguration;
  private readonly permits = new Map<string, { key: string; issuedAt: number }>();
  private readonly generations = new Map<string, number>();
  private readonly completed = new Map<string, string>();
  private readonly uncertain = new Set<string>();
  constructor(options: KubeadmClusterAdapterOptions) {
    this.config = registerKubeadmConfiguration(options); this.id = this.config.id; this.scope = this.config.scope;
    if (this.config.intent.mode !== 'create') throw new ClusterBootstrapAdapterError('kubeadm-create-mode-required');
  }
  private intent(input: BootstrapIntent): BootstrapIntent {
    const intent = readBootstrapIntent(input);
    if (fingerprint(intent) !== fingerprint(this.config.intent)) throw new ClusterBootstrapAdapterError('bootstrap-intent-changed');
    return intent;
  }
  private plan(input: BootstrapPlan): BootstrapPlan {
    const plan = readBootstrapPlan(input);
    if (plan.adapterId !== this.id || plan.scope !== this.scope || plan.intentDigest !== fingerprint(this.config.intent)
      || plan.configurationDigest !== this.config.digest || canonical(plan.strategy) !== canonical({ id: this.config.strategy.id, digest: this.config.strategy.digest })) throw new ClusterBootstrapAdapterError('bootstrap-plan-not-admitted');
    for (const host of this.config.hosts) if (canonical(descriptors(host.transport)) !== canonical(host.descriptors)) throw new ClusterBootstrapAdapterError('bootstrap-actions-changed');
    if (plan.disposition === 'create') {
      const nodes = this.config.intent.topology.nodes;
      if (plan.hostIdentities.length !== nodes.length || nodes.some(node => !plan.hostIdentities.some(identity => identity.hostId === node.hostId))) throw new ClusterBootstrapAdapterError('bootstrap-host-identities-incomplete');
      const initialize = plan.actions.filter(action => action.phase === 'initialize'), network = plan.actions.filter(action => action.phase === 'network');
      const primary = nodes.find(node => node.role === 'control-plane');
      if (initialize.length !== 1 || network.length !== 1 || initialize[0]!.hostId !== primary?.hostId || network[0]!.hostId !== primary?.hostId
        || network[0]!.id !== this.config.networkActionId) throw new ClusterBootstrapAdapterError('bootstrap-actions-incomplete');
      const phaseOrder = { prepare: 0, initialize: 1, network: 2, join: 3 };
      if (plan.actions.some((action, index) => index > 0 && phaseOrder[action.phase] < phaseOrder[plan.actions[index - 1]!.phase])) throw new ClusterBootstrapAdapterError('bootstrap-action-order-invalid');
      const requiredPreparation = (plan.preparations ?? []).filter(preparation => preparation.status === 'preparable').flatMap(preparation => preparation.actions);
      if (canonical(plan.actions.filter(action => action.phase === 'prepare')) !== canonical(requiredPreparation)) throw new ClusterBootstrapAdapterError('bootstrap-preparation-actions-incomplete');
      for (const action of plan.actions) {
        const host = this.config.hosts.find(host => host.hostId === action.hostId), descriptor = host?.descriptors.find(value => value.id === action.id);
        if (!host || !nodes.some(node => node.hostId === action.hostId) || !descriptor || descriptor.effect !== 'mutating' || descriptor.digest !== action.actionDigest
          || (action.phase === 'initialize' && action.id !== host.initializeActionId)
          || (action.phase === 'join' && action.id !== host.joinActionId)
          || (action.phase === 'prepare' && !plan.preparations?.some(preparation => preparation.hostId === host.hostId
            && preparation.recipeDigest === host.preparation.recipeDigest && preparation.actions.some(value => canonical(value) === canonical(action))))) throw new ClusterBootstrapAdapterError('bootstrap-action-not-admitted');
      }
      if (nodes.filter(node => node.role === 'worker').some(node => !plan.actions.some(action => action.hostId === node.hostId && action.phase === 'join'))) throw new ClusterBootstrapAdapterError('bootstrap-actions-incomplete');
    }
    return plan;
  }
  private progress(plan: BootstrapPlan, input: BootstrapContext): BootstrapContext {
    const context = readBootstrapContext(input), expected = plan.actions.slice(0, context.completedActionIds.length).map(action => action.id);
    if (canonical(expected) !== canonical(context.completedActionIds)) throw new ClusterBootstrapAdapterError('bootstrap-action-progress-invalid');
    const initialized = plan.actions.some(action => action.phase === 'initialize' && context.completedActionIds.includes(action.id));
    if (initialized !== !!context.resource) throw new ClusterBootstrapAdapterError('created-cluster-identity-required');
    return context;
  }
  async assess(input: BootstrapIntent, values: readonly HostFactsSnapshot[], inputContext: BootstrapContext): Promise<BootstrapPlan> {
    const intent = this.intent(input), context = readBootstrapContext(inputContext), facts = values.map(readHostFactsSnapshot);
    if (context.completedActionIds.length) throw new ClusterBootstrapAdapterError('initial-assessment-requires-clean-progress');
    const capabilities = await kubeadmCapabilities(this.config, facts, context);
    let observation: ClusterObservation;
    try { observation = await this.find(context); } catch { observation = { status: 'unknown' }; }
    return assessBootstrapStrategy(this.config.strategy, { adapterId: this.id, scope: this.scope, configurationDigest: this.config.digest,
      intent, facts, observation, capabilities: { supported: capabilities.supported, reasons: capabilities.reasons },
      actions: capabilities.actions, preparations: capabilities.preparations });
  }
  async revalidate(input: BootstrapPlan, inputIntent: BootstrapIntent, values: readonly HostFactsSnapshot[], inputContext: BootstrapContext): Promise<BootstrapRevalidation> {
    const requestedExecution = inputContext && typeof inputContext === 'object' ? Object.getOwnPropertyDescriptor(inputContext, 'executionId') : undefined;
    if (requestedExecution && 'value' in requestedExecution && typeof requestedExecution.value === 'string') this.permits.delete(requestedExecution.value);
    const supplied = readBootstrapContext(inputContext); this.permits.delete(supplied.executionId);
    const generation = (this.generations.get(supplied.executionId) ?? 0) + 1;
    if (!this.generations.has(supplied.executionId) && this.generations.size >= 128) throw new ClusterBootstrapAdapterError('bootstrap-execution-limit');
    this.generations.set(supplied.executionId, generation);
    const plan = this.plan(input), context = this.progress(plan, supplied); this.intent(inputIntent);
    if (this.uncertain.has(context.executionId)) throw new ClusterBootstrapAdapterError('bootstrap-execution-uncertain');
    const knownProgress = this.completed.get(context.executionId);
    if (knownProgress !== undefined && knownProgress !== canonical(context.completedActionIds)) throw new ClusterBootstrapAdapterError('bootstrap-completed-progress-changed');
    const facts = values.map(readHostFactsSnapshot), reasons: string[] = [];
    if (plan.disposition !== 'create') reasons.push('bootstrap-plan-blocked');
    for (const identity of plan.hostIdentities) {
      const observed = facts.filter(fact => fact.host.id === identity.hostId);
      if (observed.length !== 1 || observed[0]!.identityDigest !== identity.identityDigest) reasons.push('bootstrap-host-identity-changed');
    }
    const capabilities = await kubeadmCapabilities(this.config, facts, context, plan); reasons.push(...capabilities.reasons);
    for (const action of plan.actions.filter(action => action.phase === 'prepare')) {
      if (!capabilities.preparations.some(preparation => preparation.hostId === action.hostId
        && preparation.actions.some(current => canonical(current) === canonical(action)))) reasons.push('bootstrap-preparation-actions-changed');
    }
    let observation: ClusterObservation;
    try { observation = await this.find(context); } catch { observation = { status: 'unknown' }; }
    if (context.resource) {
      if (observation.status !== 'present' || !sameCluster(context.resource, observation.resource!)) reasons.push('created-cluster-identity-changed');
      if (normalizedPlatformVersion(observation.platformVersion) !== this.config.intent.topology.version) reasons.push('created-platform-version-unverified');
    } else if (observation.status !== 'absent') reasons.push('cluster-is-not-absent');
    const result = readBootstrapRevalidation({ valid: reasons.length === 0, planDigest: plan.digest,
      observationsDigest: fingerprint({ observations: preparationEvidenceDigest(facts, capabilities.preparations), observation }),
      reasons: [...new Set(reasons)].sort(), preparations: capabilities.preparations });
    if (result.valid && this.generations.get(context.executionId) === generation && plan.actions[context.completedActionIds.length]) {
      this.permits.set(context.executionId, { key: this.permitKey(plan, context), issuedAt: Date.now() });
    }
    return result;
  }
  private permitKey(plan: BootstrapPlan, context: BootstrapContext): string {
    const resource = context.resource ? { id: context.resource.id, kind: context.resource.kind, physicalId: context.resource.physicalId, scope: context.resource.scope } : null;
    return fingerprint({ planDigest: plan.digest, executionId: context.executionId, completedActionIds: context.completedActionIds,
      resource, actionId: plan.actions[context.completedActionIds.length]?.id ?? null });
  }
  async executeAction(input: BootstrapPlan, actionId: string, inputContext: BootstrapContext): Promise<BootstrapActionReceipt> {
    const plan = this.plan(input), context = this.progress(plan, inputContext), id = identifier(actionId);
    const action = plan.actions[context.completedActionIds.length];
    if (plan.disposition !== 'create' || !action || action.id !== id) throw new ClusterBootstrapAdapterError('bootstrap-action-not-next');
    const permit = this.permits.get(context.executionId); this.permits.delete(context.executionId);
    if (!permit || permit.key !== this.permitKey(plan, context) || Date.now() - permit.issuedAt > this.config.maxObservationAgeMs
      || this.uncertain.has(context.executionId)) throw new ClusterBootstrapAdapterError('bootstrap-fresh-preflight-required');
    const host = this.config.hosts.find(host => host.hostId === action.hostId)!, identity = plan.hostIdentities.find(identity => identity.hostId === action.hostId)!;
    const before = await this.find(context);
    if (context.resource ? before.status !== 'present' || !sameCluster(context.resource, before.resource!)
      || normalizedPlatformVersion(before.platformVersion) !== this.config.intent.topology.version : before.status !== 'absent') throw new ClusterBootstrapAdapterError('cluster-precondition-changed');
    let resource: ResourceHandle | undefined;
    try {
      const result = await host.transport.run(id, { executionId: context.executionId, operationId: context.operationId, expectedIdentityDigest: identity.identityDigest });
      if (action.phase !== 'prepare' && result.stdout.trim() !== KUBEADM_ACTION_COMPLETE) throw Error();
      if (action.phase === 'initialize') {
        const observed = await this.find(context);
        if (observed.status !== 'present' || normalizedPlatformVersion(observed.platformVersion) !== this.config.intent.topology.version) throw Error(); resource = observed.resource!;
      } else if (context.resource) {
        const observed = await this.find(context);
        if (observed.status !== 'present' || !sameCluster(context.resource, observed.resource!) || normalizedPlatformVersion(observed.platformVersion) !== this.config.intent.topology.version) throw Error();
      }
    } catch { this.uncertain.add(context.executionId); throw new ClusterBootstrapAdapterError('bootstrap-action-outcome-unknown', 'uncertain'); }
    this.completed.set(context.executionId, canonical([...context.completedActionIds, id]));
    const receiptId = `bootstrap-${fingerprint({ plan: plan.digest, id, executionId: context.executionId, operationId: context.operationId })}`;
    return readBootstrapActionReceipt({ id: receiptId, actionId: id, hostId: host.hostId, status: 'completed', receipt: { id: receiptId }, ...(resource ? { resource } : {}) });
  }
  find(context: BootstrapContext): Promise<ClusterObservation> { return inspectCluster(this.config.connection, this.config.intent.id, this.scope, readBootstrapContext(context)); }
  publishAccess(resource: ResourceHandle, context: BootstrapContext): Promise<PublishedClusterAccess | undefined> { return publishClusterAccess(this.config.connection, resource, context, this.config.intent.topology.version); }
  verify(resource: ResourceHandle, profileId: string, context: BootstrapContext): Promise<VerificationResult> { return verifyClusterConnection(this.config.connection, resource, identifier(profileId), context, this.config.intent.topology.version); }
}

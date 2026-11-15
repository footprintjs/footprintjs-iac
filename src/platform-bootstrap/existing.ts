import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import type { HostFactsSnapshot } from '../platform-access/types.ts';
import type { ResourceHandle, VerificationResult } from '../resource-flow/types.ts';
import { fingerprint } from '../util.ts';
import { inspectCluster, publishClusterAccess, sameCluster, verifyClusterConnection } from './connection.ts';
import { identifier, normalizedPlatformVersion, readBootstrapContext, readBootstrapIntent, readBootstrapPlan, readBootstrapRevalidation } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';
import { assessBootstrapStrategy, conservativeClusterBootstrapStrategy } from './strategy.ts';
import type { BootstrapActionReceipt, BootstrapContext, BootstrapIntent, BootstrapPlan, BootstrapRevalidation, ClusterConnectionPort, ClusterLifecycleAdapter, ClusterObservation, ClusterBootstrapStrategy, PublishedClusterAccess } from './types.ts';

export interface ExistingClusterAdapterOptions { id: string; scope: string; intent: BootstrapIntent; connection: ClusterConnectionPort; strategy?: ClusterBootstrapStrategy }
/** Finds an existing cluster. Missing or unreadable targets never fall back to installation. */
export class ExistingClusterAdapter implements ClusterLifecycleAdapter {
  readonly id: string; readonly scope: string;
  private readonly intent: BootstrapIntent;
  private readonly connection: ClusterConnectionPort;
  private readonly strategy: ClusterBootstrapStrategy;
  private readonly configurationDigest: string;
  constructor(options: ExistingClusterAdapterOptions) {
    this.id = identifier(options.id); this.scope = identifier(options.scope); this.intent = readBootstrapIntent(options.intent);
    if (this.intent.mode !== 'existing') throw new ClusterBootstrapAdapterError('existing-cluster-mode-required');
    this.connection = Object.freeze({ inspect: options.connection.inspect.bind(options.connection), publishAccess: options.connection.publishAccess.bind(options.connection), verify: options.connection.verify.bind(options.connection) });
    const strategy = options.strategy ?? conservativeClusterBootstrapStrategy();
    this.strategy = Object.freeze({ id: strategy.id, digest: strategy.digest, assess: strategy.assess.bind(strategy) });
    this.configurationDigest = fingerprint({ adapterId: this.id, scope: this.scope, intent: this.intent, strategy: { id: strategy.id, digest: strategy.digest } });
  }
  async assess(intent: BootstrapIntent, facts: readonly HostFactsSnapshot[], context: BootstrapContext): Promise<BootstrapPlan> {
    if (fingerprint(readBootstrapIntent(intent)) !== fingerprint(this.intent)) throw new ClusterBootstrapAdapterError('bootstrap-intent-changed');
    const observation = await this.find(context), reasons: string[] = [];
    if (observation.status === 'present') {
      const actualVersion = normalizedPlatformVersion(observation.platformVersion);
      if (!actualVersion) reasons.push('existing-platform-version-unverified');
      else if (actualVersion !== this.intent.topology.version) reasons.push('existing-platform-version-mismatch');
    }
    return assessBootstrapStrategy(this.strategy, { adapterId: this.id, scope: this.scope, configurationDigest: this.configurationDigest,
      intent: this.intent, facts: facts.map(readHostFactsSnapshot), observation, capabilities: { supported: !reasons.length, reasons }, actions: [] });
  }
  async revalidate(input: BootstrapPlan, intent: BootstrapIntent, facts: readonly HostFactsSnapshot[], context: BootstrapContext): Promise<BootstrapRevalidation> {
    const plan = readBootstrapPlan(input), current = await this.assess(intent, facts, context);
    const valid = plan.digest === current.digest && plan.disposition === 'connect' && !!plan.existingResource && !!current.existingResource
      && sameCluster(plan.existingResource, current.existingResource);
    return readBootstrapRevalidation({ valid, planDigest: plan.digest, observationsDigest: current.observationsDigest, reasons: valid ? [] : ['existing-cluster-plan-changed'] });
  }
  async executeAction(_plan: BootstrapPlan, _actionId: string, _context: BootstrapContext): Promise<BootstrapActionReceipt> {
    throw new ClusterBootstrapAdapterError('existing-cluster-has-no-mutations');
  }
  find(context: BootstrapContext): Promise<ClusterObservation> { return inspectCluster(this.connection, this.intent.id, this.scope, readBootstrapContext(context)); }
  publishAccess(resource: ResourceHandle, context: BootstrapContext): Promise<PublishedClusterAccess | undefined> { return publishClusterAccess(this.connection, resource, context, this.intent.topology.version); }
  verify(resource: ResourceHandle, profileId: string, context: BootstrapContext): Promise<VerificationResult> { return verifyClusterConnection(this.connection, resource, identifier(profileId), context, this.intent.topology.version); }
}

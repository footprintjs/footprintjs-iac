import { freeze, jsonCopy } from '../graph/data.ts';
import { hostActionDigest } from '../platform-access/data.ts';
import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import type { HostAction, HostFactsSnapshot } from '../platform-access/types.ts';
import { fingerprint } from '../util.ts';
import { identifier, readBootstrapContext, readBootstrapIntent } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';
import { createPinnedHostPreparationAction, type PinnedHostPreparationActionOptions } from './preparation-actions.ts';
import type { BootstrapAction, BootstrapContext, BootstrapIntent, HostPreparationAssessment, HostPreparationPort } from './types.ts';

export const HOST_PREPARATION_CHECKS = ['node-cleanliness', 'network', 'configuration', 'cni-artifacts', 'packages', 'runtime'] as const;
export interface HostPreparationObservation {
  status: HostPreparationAssessment['status'];
  /** Originating measurement time. A cached observation must retain its original age. */
  observedAt: number;
  checks: { id: typeof HOST_PREPARATION_CHECKS[number]; passed: boolean }[];
}
/** Trusted, read-only site adapter. Check configured artifacts, network and ownership at the actual host.
 * A passed inventory value is evidence from this port, not an inference from an installer exit code.
 */
export interface HostPreparationProbe {
  inspect(facts: HostFactsSnapshot, intent: BootstrapIntent, context: BootstrapContext): Promise<HostPreparationObservation>;
}
export interface PinnedRecipeHostPreparationOptions {
  id: string;
  recipes: readonly (PinnedHostPreparationActionOptions & { hostId: string })[];
  probe: HostPreparationProbe;
}

/** OS/site-specific recipes are immutable artifacts, separate from cluster policy and transport.
 * Register hostActions() at a trusted transport; recordings receive descriptors and measured checks only.
 */
export class PinnedRecipeHostPreparation implements HostPreparationPort {
  readonly id: string;
  readonly recipeDigest: string;
  private readonly registry = new Map<string, readonly Readonly<HostAction>[]>();
  private readonly probe: HostPreparationProbe;

  constructor(options: PinnedRecipeHostPreparationOptions) {
    this.id = identifier(options.id);
    const recipes = jsonCopy(options.recipes) as unknown as PinnedRecipeHostPreparationOptions['recipes'];
    if (!Array.isArray(recipes) || !recipes.length || recipes.length > 128 || typeof options.probe?.inspect !== 'function') throw new ClusterBootstrapAdapterError('invalid-preparation-registration');
    const registrations: { hostId: string; actionDigest: string }[] = [];
    const actionIds = new Set<string>();
    for (const recipe of recipes) {
      const { hostId: inputHostId, ...actionOptions } = recipe;
      const hostId = identifier(inputHostId), action = createPinnedHostPreparationAction(actionOptions);
      if (actionIds.has(action.id)) throw new ClusterBootstrapAdapterError('duplicate-preparation-action');
      actionIds.add(action.id);
      this.registry.set(hostId, freeze([...(this.registry.get(hostId) ?? []), action]));
      registrations.push({ hostId, actionDigest: hostActionDigest(action) });
    }
    this.recipeDigest = fingerprint({ id: this.id, registrations });
    this.probe = { inspect: options.probe.inspect.bind(options.probe) };
  }

  hostActions(hostId: string): readonly Readonly<HostAction>[] {
    const actions = this.registry.get(identifier(hostId));
    if (!actions) throw new ClusterBootstrapAdapterError('preparation-host-not-registered');
    return actions;
  }

  async inspect(inputFacts: HostFactsSnapshot, inputIntent: BootstrapIntent, inputContext: BootstrapContext): Promise<HostPreparationAssessment> {
    const facts = readHostFactsSnapshot(inputFacts), intent = readBootstrapIntent(inputIntent), context = readBootstrapContext(inputContext);
    if (!facts.identityDigest || !intent.topology.nodes.some(node => node.hostId === facts.host.id)) throw new ClusterBootstrapAdapterError('preparation-host-identity-unverified');
    const actions: BootstrapAction[] = this.hostActions(facts.host.id).map(action => ({ id: action.id, hostId: facts.host.id, phase: 'prepare', actionDigest: hostActionDigest(action) }));
    let status: HostPreparationAssessment['status'] = 'unknown';
    let observedAt = Date.now();
    let checks: HostPreparationAssessment['checks'] = HOST_PREPARATION_CHECKS.map(id => ({ id, passed: false }));
    try {
      const observation = jsonCopy(await this.probe.inspect(facts, intent, context)) as unknown as HostPreparationObservation;
      if (!observation || Object.keys(observation).some(key => !['status', 'checks', 'observedAt'].includes(key))
        || !Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0
        || !['ready', 'preparable', 'blocked', 'unknown'].includes(observation.status) || !Array.isArray(observation.checks)
        || observation.checks.length !== HOST_PREPARATION_CHECKS.length || new Set(observation.checks.map(check => check.id)).size !== HOST_PREPARATION_CHECKS.length
        || observation.checks.some(check => !check || Object.keys(check).some(key => !['id', 'passed'].includes(key))
          || !HOST_PREPARATION_CHECKS.includes(check.id) || typeof check.passed !== 'boolean')) throw Error();
      status = observation.status;
      observedAt = observation.observedAt;
      checks = HOST_PREPARATION_CHECKS.map(id => ({ id, passed: observation.checks.find(check => check.id === id)!.passed }));
    } catch { /* No provider body, artifact content, hostname, raw output or credentials enter evidence. */ }
    const assessment = { hostId: facts.host.id, identityDigest: facts.identityDigest, recipeDigest: this.recipeDigest,
      status, actions, checks, observedAt };
    return freeze({ ...assessment, digest: fingerprint(assessment) });
  }
}

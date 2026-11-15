import { freeze, jsonCopy } from '../graph/data.ts';
import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import { fingerprint } from '../util.ts';
import { identifier, readBootstrapAction, readBootstrapIntent, readBootstrapPlan, readClusterObservation, readHostPreparationAssessment, sealBootstrapPlan } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';
import type { BootstrapAssessmentInput, BootstrapPlan, ClusterBootstrapStrategy } from './types.ts';

/** Conservative common policy: a provider must establish compatibility before a strategy can create. */
export function conservativeClusterBootstrapStrategy(): ClusterBootstrapStrategy {
  const id = 'conservative-cluster-bootstrap';
  const policyDigest = fingerprint({ id, version: 1 });
  return Object.freeze({ id, digest: policyDigest, assess(input: BootstrapAssessmentInput): BootstrapPlan {
    const intent = readBootstrapIntent(input.intent), facts = input.facts.map(readHostFactsSnapshot), observation = readClusterObservation(input.observation);
    const preparations = input.preparations?.map(readHostPreparationAssessment);
    const reasons = [...input.capabilities.reasons].map(identifier);
    if (input.capabilities.supported !== true && !reasons.length) reasons.push('provider-capability-unavailable');
    const hostIdentities = intent.topology.nodes.flatMap(node => {
      const matches = facts.filter(fact => fact.host.id === node.hostId);
      if (matches.length !== 1 || !matches[0]!.identityDigest) { reasons.push('host-identity-unavailable'); return []; }
      return [{ hostId: node.hostId, identityDigest: matches[0]!.identityDigest! }];
    });
    if (intent.mode === 'existing') {
      if (observation.status !== 'present') reasons.push(observation.status === 'absent' ? 'existing-cluster-not-found' : 'cluster-observation-unknown');
    } else if (observation.status !== 'absent') reasons.push(observation.status === 'present' ? 'cluster-already-exists' : 'cluster-observation-unknown');
    const blocked = reasons.length > 0;
    const existingResource = observation.resource ? { id: observation.resource.id, kind: observation.resource.kind,
      physicalId: observation.resource.physicalId, scope: observation.resource.scope } : undefined;
    return sealBootstrapPlan({ kind: 'cluster-bootstrap-plan', version: 1, adapterId: identifier(input.adapterId), scope: identifier(input.scope),
      mode: intent.mode, intentDigest: fingerprint(intent), configurationDigest: input.configurationDigest, strategy: { id, digest: policyDigest },
      hostIdentities, ...(existingResource ? { existingResource } : {}), observationsDigest: fingerprint({ facts: facts.map(fact => fact.digest), observation, capabilities: input.capabilities,
        preparations: preparations?.map(value => value.digest) ?? [] }), ...(preparations ? { preparations } : {}),
      disposition: blocked ? 'blocked' : intent.mode === 'create' ? 'create' : 'connect', reasons: [...new Set(reasons)].sort(),
      actions: !blocked && intent.mode === 'create' ? input.actions.map(readBootstrapAction) : [] });
  } });
}

/** Common admission applies after every strategy, including user-provided policies. */
export function assessBootstrapStrategy(strategy: ClusterBootstrapStrategy, input: BootstrapAssessmentInput): BootstrapPlan {
  const detached = freeze(jsonCopy(input)) as unknown as BootstrapAssessmentInput;
  const defaultPlan = conservativeClusterBootstrapStrategy().assess(detached);
  let proposed: BootstrapPlan;
  try { proposed = readBootstrapPlan(strategy.assess(detached)); }
  catch { throw new ClusterBootstrapAdapterError('bootstrap-strategy-invalid'); }
  if (proposed.strategy.id !== strategy.id || proposed.strategy.digest !== strategy.digest
    || proposed.adapterId !== defaultPlan.adapterId || proposed.scope !== defaultPlan.scope || proposed.mode !== defaultPlan.mode
    || proposed.intentDigest !== defaultPlan.intentDigest || proposed.configurationDigest !== defaultPlan.configurationDigest
    || fingerprint(proposed.hostIdentities) !== fingerprint(defaultPlan.hostIdentities)
    || fingerprint(proposed.existingResource ?? null) !== fingerprint(defaultPlan.existingResource ?? null)
    || proposed.observationsDigest !== defaultPlan.observationsDigest || fingerprint(proposed.preparations ?? []) !== fingerprint(defaultPlan.preparations ?? [])
    || (defaultPlan.disposition === 'blocked' && proposed.disposition !== 'blocked')
    || (proposed.disposition !== 'blocked' && (proposed.disposition !== defaultPlan.disposition || fingerprint(proposed.actions) !== fingerprint(defaultPlan.actions)))) {
    throw new ClusterBootstrapAdapterError('bootstrap-strategy-not-admitted');
  }
  return proposed;
}

import { canonical, fingerprint } from '../util.ts';
import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import type { HostFactsSnapshot } from '../platform-access/types.ts';
import { readHostPreparationAssessment } from './data.ts';
import type { RegisteredKubeadmConfiguration, RegisteredKubeadmHost } from './kubeadm-config.ts';
import type { BootstrapAction, BootstrapContext, BootstrapPlan, HostPreparationAssessment } from './types.ts';

export interface KubeadmCapabilityResult { supported: boolean; reasons: string[]; actions: BootstrapAction[]; preparations: HostPreparationAssessment[] }
function action(host: RegisteredKubeadmHost, id: string | undefined, phase: BootstrapAction['phase']): BootstrapAction | undefined {
  const descriptor = host.descriptors.find(value => value.id === id && value.effect === 'mutating');
  return descriptor ? { id: descriptor.id, hostId: host.hostId, phase, actionDigest: descriptor.digest } : undefined;
}
export async function kubeadmCapabilities(config: RegisteredKubeadmConfiguration, values: readonly HostFactsSnapshot[], context: BootstrapContext, plan?: BootstrapPlan): Promise<KubeadmCapabilityResult> {
  const facts = values.map(readHostFactsSnapshot), reasons: string[] = [], prepareActions: BootstrapAction[] = [], preparations: HostPreparationAssessment[] = [];
  const nodes = config.intent.topology.nodes, primaryNodes = nodes.filter(node => node.role === 'control-plane');
  if (!/^1\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(config.intent.topology.version)) reasons.push('kubeadm-upstream-stable-version-required');
  if (primaryNodes.length !== 1) reasons.push('kubeadm-single-control-plane-required');
  if (!config.intent.topology.podNetworkCidr || !config.intent.topology.serviceNetworkCidr) reasons.push('kubeadm-network-intent-required');
  if (facts.length !== nodes.length) reasons.push('host-inventory-incomplete');
  for (const node of nodes) {
    const host = config.hosts.find(host => host.hostId === node.hostId), matches = facts.filter(fact => fact.host.id === node.hostId);
    if (!host || matches.length !== 1) { reasons.push('host-inventory-incomplete'); continue; }
    const fact = matches[0]!;
    if (Date.now() - fact.observedAt > config.maxObservationAgeMs || fact.observedAt > Date.now() + config.maxFutureSkewMs) reasons.push('host-observation-stale');
    if (!fact.identityDigest || fact.status === 'unavailable' || canonical(fact.host) !== canonical(host.host)) { reasons.push('host-identity-unavailable'); continue; }
    if (fact.os.family !== 'linux' || !fact.os.distribution || !fact.os.version || !fact.os.kernel || !['amd64', 'arm64'].includes(fact.architecture)) reasons.push('host-platform-unsupported');
    if (fact.privilege !== 'root' && fact.privilege !== 'sudo-noninteractive') reasons.push('host-privilege-unavailable');
    if (fact.cpuCount === null || fact.cpuCount < (node.role === 'control-plane' ? config.minimums.controlPlaneCpu : config.minimums.workerCpu)) reasons.push('host-cpu-insufficient');
    if (fact.memory.totalBytes === null || fact.memory.totalBytes < config.minimums.totalMemoryBytes) reasons.push('host-memory-insufficient');
    if (fact.memory.availableBytes === null || fact.memory.availableBytes <= 0) reasons.push('host-memory-availability-unknown');
    if (fact.disk.availableBytes === null || fact.disk.availableBytes < config.minimums.availableDiskBytes) reasons.push('host-disk-insufficient');
    const completedForHost = plan?.actions.filter(action => action.hostId === node.hostId && context.completedActionIds.includes(action.id)) ?? [];
    if (!completedForHost.length && fact.memory.availableBytes !== null && fact.memory.availableBytes < config.minimums.availableMemoryBytes) reasons.push('host-memory-unallocated-insufficient');
    const acquired = completedForHost.some(action => action.phase === 'initialize' || action.phase === 'join');
    if (fact.kubernetes.status === 'present' && !acquired) reasons.push('host-already-has-kubernetes');
    let preparation: HostPreparationAssessment;
    try { preparation = readHostPreparationAssessment(await host.preparation.inspect(fact, config.intent, context)); }
    catch { reasons.push('host-preparation-unavailable'); continue; }
    preparations.push(preparation);
    if (Date.now() - preparation.observedAt > config.maxObservationAgeMs || preparation.observedAt > Date.now() + config.maxFutureSkewMs) reasons.push('host-preparation-stale');
    if (preparation.hostId !== host.hostId || preparation.identityDigest !== fact.identityDigest || preparation.recipeDigest !== host.preparation.recipeDigest) { reasons.push('host-preparation-identity-mismatch'); continue; }
    if (preparation.status !== 'ready' && preparation.status !== 'preparable') { reasons.push('host-preparation-not-cleared'); continue; }
    const required = ['network', 'configuration', 'cni-artifacts', ...(!acquired ? ['node-cleanliness'] : [])];
    if (required.some(id => !preparation.checks.some(check => check.id === id && check.passed))) reasons.push('host-site-prerequisites-not-verified');
    for (const planned of preparation.actions) {
      const registered = action(host, planned.id, 'prepare');
      if (!registered || canonical(registered) !== canonical(planned)) reasons.push('preparation-action-not-registered');
    }
    const pending = plan?.actions.filter(action => action.hostId === node.hostId && action.phase === 'prepare' && !context.completedActionIds.includes(action.id));
    if (preparation.status === 'preparable') {
      if (!preparation.actions.length || (plan && !pending?.length)) reasons.push('host-preparation-incomplete');
      prepareActions.push(...preparation.actions);
    } else {
      if (pending?.length) reasons.push('host-preparation-state-changed');
      if (['packages', 'runtime'].some(id => !preparation.checks.some(check => check.id === id && check.passed))) reasons.push('host-runtime-not-verified');
      for (const name of ['kubeadm', 'kubelet', 'kubectl'] as const) {
        if (fact.tools[name]?.status !== 'installed' || fact.tools[name]?.version?.replace(/^v/, '') !== config.intent.topology.version) reasons.push('host-kubernetes-version-mismatch');
      }
      if (fact.tools.containerd?.status !== 'installed' || !fact.tools.containerd?.version) reasons.push('host-runtime-unavailable');
    }
  }
  const primary = config.hosts.find(host => host.hostId === primaryNodes[0]?.hostId);
  const initialize = primary ? action(primary, primary.initializeActionId, 'initialize') : undefined;
  const network = primary ? action(primary, config.networkActionId, 'network') : undefined;
  if (!initialize) reasons.push('kubeadm-initialize-action-required');
  if (!network) reasons.push('kubeadm-network-action-required');
  const joins: BootstrapAction[] = [];
  for (const node of nodes.filter(node => node.role === 'worker')) {
    const host = config.hosts.find(host => host.hostId === node.hostId), join = host ? action(host, host.joinActionId, 'join') : undefined;
    if (!join) reasons.push('kubeadm-join-action-required'); else joins.push(join);
  }
  const actions = [...prepareActions, ...(initialize ? [initialize] : []), ...(network ? [network] : []), ...joins];
  if (new Set(actions.map(action => action.id)).size !== actions.length) reasons.push('bootstrap-action-identity-ambiguous');
  return { supported: !reasons.length, reasons: [...new Set(reasons)].sort(), actions, preparations };
}
export function preparationEvidenceDigest(facts: readonly HostFactsSnapshot[], preparations: readonly HostPreparationAssessment[]): string {
  return fingerprint({ facts: facts.map(fact => fact.digest), preparations: preparations.map(preparation => preparation.digest) });
}

import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import { readBootstrapPlan } from '../platform-bootstrap/data.ts';
import type { BootstrapContext, BootstrapPlan } from '../platform-bootstrap/types.ts';
import type { HostFactsSnapshot } from '../platform-access/types.ts';
import { canonical, fingerprint } from '../util.ts';
import type { PlatformScope } from './scope.ts';
import type { FilePlatformBootstrapStore } from './store.ts';
import type { PlatformBootstrapState, PlatformWorkflowOptions } from './types.ts';

export interface PlatformStages {
  options: PlatformWorkflowOptions;
  state: PlatformBootstrapState;
  store: FilePlatformBootstrapStore;
  profileIds(): Promise<readonly string[]>;
}
export const contextFor = (config: PlatformStages, stage: string): BootstrapContext => ({
  executionId: config.state.executionId!, operationId: fingerprint({ executionId: config.state.executionId, stage }),
  completedActionIds: config.state.actions.filter(action => action.status === 'completed').map(action => action.id),
  ...(config.state.resource ? { resource: config.state.resource } : {}),
});
export const persist = (config: PlatformStages) => config.store.save({ version: 1, state: config.state });

/** Catch tool errors before the native engine receives them; never persist command output or causes. */
export function safeStage(config: PlatformStages, code: string, work: (scope: PlatformScope) => Promise<void>) {
  return async (scope: PlatformScope) => {
    try { await work(scope); }
    catch {
      config.state.errorCode = code;
      try { await persist(config); } catch { /* A persistence failure is retained by the outer run. */ }
      throw Error(code);
    }
  };
}
export async function discoverFacts(config: PlatformStages, stage: string) {
  const facts = [];
  for (const host of config.options.hosts) {
    const context = contextFor(config, stage);
    const observed = readHostFactsSnapshot(await config.options.discovery!.inspect(host, { executionId: context.executionId, operationId: context.operationId }));
    if (canonical(observed.host) !== canonical(host)) throw Error('Host discovery identity differs');
    facts.push(observed);
  }
  return facts;
}
export function admitFreshFacts(config: PlatformStages, facts: readonly HostFactsSnapshot[]): void {
  const now = Date.now(), maxAge = config.options.maxFactAgeMs ?? 30_000;
  if (facts.some(fact => fact.observedAt > now + 1000 || now - fact.observedAt > maxAge)) throw Error('The host observation is stale or future dated');
}
/** Common admission remains mandatory even when the host registers a custom lifecycle strategy. */
export function admitMutationHosts(config: PlatformStages, plan: BootstrapPlan, facts: readonly HostFactsSnapshot[]): void {
  if (plan.disposition !== 'create') return;
  admitFreshFacts(config, facts);
  if (facts.length !== config.options.intent.topology.nodes.length || plan.hostIdentities.length !== facts.length) throw Error('The planned host inventory is incomplete');
  for (const node of config.options.intent.topology.nodes) {
    const fact = facts.find(value => value.host.id === node.hostId), expected = plan.hostIdentities.find(value => value.hostId === node.hostId);
    if (!fact || !expected || fact.identityDigest !== expected.identityDigest || fact.status === 'unavailable' || !fact.identityDigest
      || fact.os.family === 'unknown' || fact.os.distribution === null || fact.os.version === null
      || fact.architecture === 'unknown' || fact.cpuCount === null || fact.memory.totalBytes === null || fact.memory.availableBytes === null
      || fact.disk.totalBytes === null || fact.disk.availableBytes === null || fact.privilege === 'unknown') throw Error('The planned host facts are unknown, stale or retargeted');
  }
}
export function bindPlatformStage(config: PlatformStages) {
  return safeStage(config, 'platform-binding-failed', async scope => {
    scope.setValue('bindingDigest', config.state.bindingDigest);
    scope.setValue('executionId', config.state.executionId);
    scope.setValue('intent', config.options.intent);
    scope.setValue('hosts', config.options.hosts);
    if (config.state.plan) scope.setValue('plan', config.state.plan);
  });
}
export function discoverPlatformStage(config: PlatformStages) {
  return safeStage(config, 'platform-discovery-failed', async scope => {
    const facts = await discoverFacts(config, 'discover');
    config.state.facts = facts; scope.setValue('facts', facts); await persist(config); admitFreshFacts(config, facts);
  });
}
export function assessPlatformStage(config: PlatformStages) {
  return safeStage(config, 'platform-assessment-failed', async scope => {
    if (scope.getValue('bindingDigest') !== config.state.bindingDigest || canonical(scope.getValue('facts')) !== canonical(config.state.facts)) throw Error();
    const plan = readBootstrapPlan(await config.options.lifecycle.assess(config.options.intent, config.state.facts!, contextFor(config, 'assess')));
    if (plan.adapterId !== config.options.lifecycle.id || plan.scope !== config.options.lifecycle.scope || plan.mode !== config.options.intent.mode
      || plan.intentDigest !== fingerprint(config.options.intent)
      || plan.actions.some(action => !config.options.hosts.some(host => host.id === action.hostId))) throw Error();
    if (plan.disposition !== 'blocked' && ((plan.mode === 'create' && plan.disposition !== 'create') || (plan.mode === 'existing' && (plan.disposition !== 'connect' || plan.actions.length)))) throw Error();
    admitMutationHosts(config, plan, config.state.facts!);
    config.state.plan = plan;
    config.state.actions = plan.actions.map(action => ({ id: action.id, hostId: action.hostId, actionDigest: action.actionDigest, status: 'pending' }));
    scope.setValue('plan', plan); await persist(config);
    scope.setValue('eligible', plan.disposition !== 'blocked');
    if (plan.disposition === 'blocked') throw Error('Platform plan blocked');
  });
}

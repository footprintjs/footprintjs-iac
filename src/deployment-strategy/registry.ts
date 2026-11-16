import { identifier } from '../graph/data.ts';
import type { DeploymentStrategyAdapter, DeploymentStrategyDescription } from './types.ts';

export function captureDeploymentAdapter(adapter: DeploymentStrategyAdapter): DeploymentStrategyAdapter {
  const id = identifier(adapter?.id, 'deployment strategy ID'), kind = identifier(adapter?.kind, 'deployment strategy kind');
  if (['plan','apply','snapshot'].some(key => typeof adapter[key as keyof DeploymentStrategyAdapter] !== 'function')) throw Error('deployment-controller-required');
  if(adapter.reconcile!==undefined&&typeof adapter.reconcile!=='function')throw Error('deployment-reconciliation-controller-required');
  return Object.freeze({ id, kind, plan: adapter.plan.bind(adapter), apply: adapter.apply.bind(adapter), snapshot: adapter.snapshot.bind(adapter),
    ...(adapter.reconcile?{reconcile:adapter.reconcile.bind(adapter)}:{}) });
}
/** Registry construction is pure. Only a registered controller may receive an execution request. */
export class DeploymentStrategyRegistry {
  private readonly adapters: ReadonlyMap<string, DeploymentStrategyAdapter>;
  constructor(input: { adapters: readonly DeploymentStrategyAdapter[] }) {
    if (!Array.isArray(input?.adapters) || !input.adapters.length || input.adapters.length > 128) throw Error('deployment-strategies-required');
    const captured = input.adapters.map(captureDeploymentAdapter);
    if (new Set(captured.map(adapter => adapter.id)).size !== captured.length) throw Error('duplicate-deployment-strategy');
    this.adapters = new Map(captured.map(adapter => [adapter.id, adapter]));
  }
  list(): DeploymentStrategyDescription[] { return [...this.adapters.values()].map(({id,kind}) => ({id,kind})); }
  select(id: string): DeploymentStrategyAdapter {
    identifier(id, 'deployment strategy ID'); const adapter = this.adapters.get(id);
    if (!adapter) throw Error('deployment-strategy-not-registered');
    return adapter;
  }
}

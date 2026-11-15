import { captureDeploymentAdapter } from './registry.ts';
import type { DeploymentStrategyAdapter } from './types.ts';

/** Bridges an existing guarded Kubernetes/Master controller without another execution engine. */
export function createKubernetesDeploymentAdapter(input: { id: string; controller: Pick<DeploymentStrategyAdapter, 'plan'|'apply'|'snapshot'> }): DeploymentStrategyAdapter {
  return captureDeploymentAdapter({ id: input.id, kind: 'kubernetes', plan: input.controller.plan.bind(input.controller),
    apply: input.controller.apply.bind(input.controller), snapshot: input.controller.snapshot.bind(input.controller) });
}

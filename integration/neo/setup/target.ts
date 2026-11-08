import { resolve } from 'node:path';

export const REVIEW_CLUSTER = 'footprint-iac-review';
export const REVIEW_CONTEXT = `kind-${REVIEW_CLUSTER}`;
export const REVIEW_NODE_IMAGE = 'kindest/node:v1.37.0';

/** These two local fixtures are the only destinations this runner accepts. */
export function reviewTarget(root: string, context: string) {
  if (context !== REVIEW_CONTEXT && context !== 'kind-footprint-iac-test') {
    throw new Error('Neo review accepts only kind-footprint-iac-review or kind-footprint-iac-test');
  }
  return {
    context,
    kubeconfig: resolve(root, '.artifacts', context === REVIEW_CONTEXT ? 'kubeconfig-review' : 'kubeconfig'),
    stateDirectory: context === REVIEW_CONTEXT ? resolve(root, '.artifacts/neo/review/state') : undefined,
  };
}

/** Reject a same-named container that was not created by kind for this cluster. */
export function assertReviewContainer(labels: unknown): void {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)
    || (labels as Record<string, unknown>)['io.x-k8s.kind.cluster'] !== REVIEW_CLUSTER
    || (labels as Record<string, unknown>)['io.x-k8s.kind.role'] !== 'control-plane') {
    throw new Error('The review control-plane is not owned by the dedicated kind cluster');
  }
}

export function assertReviewKubeconfig(config: unknown): void {
  const value = config as { 'current-context'?: unknown; contexts?: { name?: string; context?: { cluster?: string } }[];
    clusters?: { name?: string; cluster?: { server?: string } }[]; users?: { user?: Record<string, unknown> }[] };
  const context = value?.contexts?.find(item => item.name === REVIEW_CONTEXT);
  const cluster = value?.clusters?.find(item => item.name === context?.context?.cluster);
  const server = cluster?.cluster?.server;
  if (value?.['current-context'] !== REVIEW_CONTEXT || !context || !server
    || !/^https:\/\/127\.0\.0\.1:\d+$/.test(server) || value.contexts?.length !== 1 || value.clusters?.length !== 1
    || value.users?.length !== 1 || value.users.some(item => item.user?.exec || item.user?.['auth-provider'])) {
    throw new Error('The exported review kubeconfig must target only the dedicated loopback kind cluster');
  }
}

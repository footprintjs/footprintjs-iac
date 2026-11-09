import { resolve } from 'node:path';
import { NEO_NAMESPACE } from '../stack.ts';

export const FRESH_CLUSTER_PREFIX = 'footprint-iac-recording-';

export interface FreshNeoTarget {
  version: 1;
  stage: 'prepared';
  clusterName: string;
  context: string;
  kubeconfig: string;
  stateDirectory: string;
  namespace: typeof NEO_NAMESPACE;
  sourceCommit: string;
  images: { nodeImage: string; pythonImage: string };
  preparedAt: string;
}

export function freshTargetPaths(root: string, suffix: string) {
  if (!/^[a-f0-9]{8}$/.test(suffix)) throw new Error('Fresh target suffix must contain exactly eight lowercase hexadecimal characters');
  const clusterName = `${FRESH_CLUSTER_PREFIX}${suffix}`;
  const directory = resolve(root, '.artifacts/neo/fresh', suffix);
  return { clusterName, context: `kind-${clusterName}`, directory,
    kubeconfig: resolve(directory, 'kubeconfig'), stateDirectory: resolve(directory, 'state') };
}

export function assertFreshContainer(labels: unknown, clusterName: string): void {
  if (!/^footprint-iac-recording-[a-f0-9]{8}$/.test(clusterName) || !labels || typeof labels !== 'object'
    || Array.isArray(labels) || (labels as Record<string, unknown>)['io.x-k8s.kind.cluster'] !== clusterName
    || (labels as Record<string, unknown>)['io.x-k8s.kind.role'] !== 'control-plane') {
    throw new Error('The recording control-plane must belong to its dedicated kind cluster');
  }
}

export function assertFreshKubeconfig(config: unknown, contextName: string): void {
  const value = config as { 'current-context'?: unknown; contexts?: { name?: string; context?: { cluster?: string; user?: string } }[];
    clusters?: { name?: string; cluster?: { server?: string } }[]; users?: { name?: string; user?: Record<string, unknown> }[] };
  const context = value?.contexts?.find(item => item.name === contextName);
  const cluster = value?.clusters?.find(item => item.name === context?.context?.cluster);
  const user = value?.users?.find(item => item.name === context?.context?.user);
  if (!/^kind-footprint-iac-recording-[a-f0-9]{8}$/.test(contextName) || value?.['current-context'] !== contextName
    || value.contexts?.length !== 1 || value.clusters?.length !== 1 || value.users?.length !== 1
    || !/^https:\/\/127\.0\.0\.1:\d+$/.test(cluster?.cluster?.server ?? '') || !user
    || user.user?.exec || user.user?.['auth-provider']) {
    throw new Error('Recording credentials must address only their dedicated loopback kind cluster');
  }
}

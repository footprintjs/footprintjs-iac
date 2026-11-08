import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { capture, run } from './command.ts';
import { assertReviewContainer, assertReviewKubeconfig, REVIEW_CLUSTER, REVIEW_CONTEXT, REVIEW_NODE_IMAGE } from './target.ts';

/** Provisioning the local cluster is separate from workload mutations through InfraEngine. */
export function ensureReviewCluster(kubeconfig: string): void {
  mkdirSync(dirname(kubeconfig), { recursive: true, mode: 0o700 });
  const clusters = capture('kind', ['get', 'clusters']).split(/\r?\n/);
  if (!clusters.includes(REVIEW_CLUSTER)) {
    run('kind', ['create', 'cluster', '--name', REVIEW_CLUSTER, '--image', REVIEW_NODE_IMAGE,
      '--kubeconfig', kubeconfig, '--wait', '180s'], 240_000);
  }
  const labels = JSON.parse(capture('docker', ['inspect', '--format', '{{json .Config.Labels}}', `${REVIEW_CLUSTER}-control-plane`]));
  assertReviewContainer(labels);
  writeFileSync(kubeconfig, capture('kind', ['get', 'kubeconfig', '--name', REVIEW_CLUSTER]) + '\n', { mode: 0o600 });
  chmodSync(kubeconfig, 0o600);
  const config = JSON.parse(capture('kubectl', ['--kubeconfig', kubeconfig, 'config', 'view', '--output=json']));
  assertReviewKubeconfig(config);
  run('kubectl', ['--kubeconfig', kubeconfig, '--context', REVIEW_CONTEXT, '--request-timeout=30s',
    'wait', '--for=condition=Ready', 'node', '--all', '--timeout=180s'], 200_000);
}

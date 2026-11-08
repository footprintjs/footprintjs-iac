import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NEO_NAMESPACE } from '../stack.ts';

/** Independent API reads validate readiness and identity without bypassing the IaC mutation path. */
export async function probeDeployment(context: string, kubeconfig: string) {
  const { stdout } = await promisify(execFile)('kubectl', [
    '--kubeconfig', kubeconfig, '--context', context, '--namespace', NEO_NAMESPACE,
    '--request-timeout=30s', 'get', 'deployment', 'neo', '-o', 'json',
  ], { timeout: 31_000, maxBuffer: 2 * 1024 * 1024 });
  const live = JSON.parse(stdout);
  return {
    replicas: live.spec.replicas as number,
    updated: (live.status.updatedReplicas ?? 0) as number,
    available: (live.status.availableReplicas ?? 0) as number,
    stable: {
      uid: live.metadata.uid as string, name: live.metadata.name as string,
      namespace: live.metadata.namespace as string, labels: live.metadata.labels,
      annotations: live.metadata.annotations, selector: live.spec.selector, template: live.spec.template,
    },
  };
}

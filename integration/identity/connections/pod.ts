import { KubernetesAdapter, type CommandRunner } from '../../../src/providers/kubernetes.ts';
import { list, record, resourceName } from '../../../src/connections/kubernetes/route.ts';
import type { Resource } from '../../../src/types.ts';
import { canonical, fingerprint } from '../../../src/util.ts';
import type { IdentityTarget } from '../target.ts';

export interface IdentityPodObservation { deploymentUID: string; pod: { name: string; uid: string }; image: string }
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 253 && !/[\x00-\x1f\x7f]/.test(value);
const owner = (metadata: Record<string, any>, kind: string, uid: string) => Array.isArray(metadata.ownerReferences)
  && metadata.ownerReferences.some((ref: Record<string, any>) => ref.kind === kind && ref.uid === uid && ref.controller === true);

/** A probe may execute only in a ready Pod belonging to the exact admitted Deployment. */
export async function observeIdentityPod(target: IdentityTarget, resource: Resource, stack: string,
  runner: CommandRunner): Promise<IdentityPodObservation> {
  const name = resourceName(resource, 'Deployment', target.namespace);
  const adapter = new KubernetesAdapter({ context: target.context, kubeconfig: target.kubeconfig, namespace: target.namespace, runner, timeoutMs: 5000 });
  const observed = await adapter.observe(resource, { stack, operationId: 'connection-observation' });
  if (!observed.exists || !observed.owned || !observed.ready || observed.fingerprint !== fingerprint(resource.spec)) throw Error('source-not-ready');
  const read = async (args: string[]) => JSON.parse((await runner('kubectl', [
    '--kubeconfig', target.kubeconfig, '--context', target.context, '--namespace', target.namespace,
    '--request-timeout', '5s', 'get', ...args, '--output=json',
  ], { timeoutMs: 6000 })).stdout);
  const deployment = record(await read(['deployment', name])), meta = record(deployment.metadata);
  if (deployment.kind !== 'Deployment' || meta.name !== name || meta.namespace !== target.namespace || !identity(meta.uid)
    || meta.deletionTimestamp || meta.annotations?.['footprint-iac.dev/owner'] !== fingerprint({ stack, id: resource.id })) throw Error('source-identity-changed');
  const replicaSets = list(await read(['replicasets']));
  const replicaSetUIDs = new Set(replicaSets.filter(rs => rs.metadata?.namespace === target.namespace
    && !rs.metadata?.deletionTimestamp && identity(rs.metadata?.uid) && owner(rs.metadata, 'Deployment', meta.uid)).map(rs => rs.metadata.uid));
  const desired = record(record(record(resource.spec.spec).template).spec).containers as Record<string, any>[];
  const node = desired.find(container => container.name === 'node');
  if (!node) throw Error('source-container-missing');
  const pods = list(await read(['pods'])).filter(pod => {
    const metadata = record(pod.metadata), status = record(pod.status), spec = record(pod.spec);
    const actual = Array.isArray(spec.containers) ? spec.containers as Record<string, any>[] : [];
    const actualNode = actual.find(container => container.name === 'node');
    return metadata.namespace === target.namespace && !metadata.deletionTimestamp && identity(metadata.uid) && identity(metadata.name)
      && /^[a-z0-9][-a-z0-9]*$/.test(metadata.name) && [...replicaSetUIDs].some(uid => owner(metadata, 'ReplicaSet', uid))
      && status.phase === 'Running' && status.conditions?.some((condition: Record<string, any>) => condition.type === 'Ready' && condition.status === 'True')
      && status.containerStatuses?.some((container: Record<string, any>) => container.name === 'node' && container.ready === true)
      && desired.every(container => actual.some(item => item.name === container.name && item.image === container.image))
      && Array.isArray(actualNode?.env) && (node.env ?? []).every((entry: Record<string, any>) => actualNode!.env.some((item: Record<string, any>) => canonical(item) === canonical(entry)));
  }).sort((a, b) => String(a.metadata.uid).localeCompare(String(b.metadata.uid)));
  if (!pods.length) throw Error('source-pod-unavailable');
  return { deploymentUID: meta.uid, pod: { name: pods[0]!.metadata.name, uid: pods[0]!.metadata.uid }, image: node.image };
}

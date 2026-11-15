import { jsonCopy } from '../graph/data.ts';

export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => { if (!Array.isArray(value) || value.length > 10000) throw Error(); return value; };
const integer = (value: unknown, minimum = 0): number => { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw Error(); return value as number; };
/** Node names are DNS subdomains, unlike the single-label selectors used for namespaces. */
export function nodeName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 253 || value.split('.').some(label => !label || label.length > 63
    || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(label))) throw Error();
  return value;
}
const metadata = (value: unknown) => {
  const meta = object(value);
  if (typeof meta.name !== 'string' || typeof meta.uid !== 'string' || !meta.uid || meta.deletionTimestamp) throw Error();
  return meta;
};
const condition = (value: unknown, type: string) => array(value).filter(item => object(item).type === type).length === 1
  && array(value).some(item => object(item).type === type && object(item).status === 'True');
export const version = (value: unknown): string => {
  if (typeof value !== 'string' || !/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?$/.test(value)) throw Error();
  return value.replace(/^v/, '');
};
export function namespaceIdentity(value: unknown, namespace: string, uid: string): boolean {
  try { const body = object(jsonCopy(value)), meta = metadata(body.metadata); return body.kind === 'Namespace' && body.apiVersion === 'v1' && meta.name === namespace && meta.uid === uid; }
  catch { return false; }
}
export function nodesReady(value: unknown, names: readonly string[], expectedVersion: string): boolean {
  try {
    const body = object(jsonCopy(value)); if (body.kind !== 'NodeList' || body.apiVersion !== 'v1') return false;
    const items = array(body.items); if (!items.length || items.length !== names.length) return false;
    const observed = new Set<string>();
    for (const item of items) {
      const node = object(item), meta = metadata(node.metadata), status = object(node.status);
      if (node.kind !== undefined && node.kind !== 'Node' || !names.includes(meta.name as string) || observed.has(meta.name as string)
        || !condition(status.conditions, 'Ready') || version(object(status.nodeInfo).kubeletVersion) !== expectedVersion) return false;
      observed.add(meta.name as string);
    }
    return true;
  } catch { return false; }
}
export function systemPodsReady(value: unknown, namespace: string): boolean {
  try {
    const body = object(jsonCopy(value)); if (body.kind !== 'PodList' || body.apiVersion !== 'v1') return false;
    const items = array(body.items); if (!items.length) return false;
    const seen = new Set<string>(); let running = 0;
    for (const item of items) {
      const pod = object(item), meta = metadata(pod.metadata), status = object(pod.status);
      if (meta.namespace !== namespace || seen.has(meta.uid as string)) return false; seen.add(meta.uid as string);
      if (status.phase === 'Succeeded') continue;
      if (status.phase !== 'Running' || !condition(status.conditions, 'Ready')) return false;
      const expected = array(object(pod.spec).containers).map(container => object(container).name), containers = array(status.containerStatuses);
      if (!expected.length || new Set(expected).size !== expected.length || containers.length !== expected.length
        || new Set(containers.map(container => object(container).name)).size !== containers.length
        || containers.some(container => !expected.includes(object(container).name) || object(container).ready !== true)) return false;
      running++;
    }
    return running > 0;
  } catch { return false; }
}
export function cniReady(value: unknown, ref: { kind: 'DaemonSet' | 'Deployment'; namespace: string; name: string }): boolean {
  try {
    const body = object(jsonCopy(value)), meta = metadata(body.metadata), status = object(body.status);
    if (body.kind !== ref.kind || body.apiVersion !== 'apps/v1' || meta.name !== ref.name || meta.namespace !== ref.namespace
      || integer(status.observedGeneration) < integer(meta.generation, 1)) return false;
    if (ref.kind === 'DaemonSet') {
      const desired = integer(status.desiredNumberScheduled, 1);
      return integer(status.currentNumberScheduled) === desired && integer(status.updatedNumberScheduled) === desired
        && integer(status.numberReady) === desired && integer(status.numberAvailable) === desired && integer(status.numberMisscheduled) === 0;
    }
    const desired = integer(object(body.spec).replicas, 1);
    return integer(status.replicas) === desired && integer(status.updatedReplicas) === desired && integer(status.readyReplicas) === desired
      && integer(status.availableReplicas) === desired && (status.unavailableReplicas === undefined || integer(status.unavailableReplicas) === 0)
      && condition(status.conditions, 'Available');
  } catch { return false; }
}

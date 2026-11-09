import { isIP } from 'node:net';
import type { JsonObject, Resource } from '../../types.ts';
import { canonical, fingerprint } from '../../util.ts';

type ObjectValue = Record<string, any>;
export function record(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kubernetes connection observation must be an object');
  return value as ObjectValue;
}
export function list(value: unknown): ObjectValue[] {
  const items = record(value).items;
  if (!Array.isArray(items)) throw new Error('Kubernetes connection observation must contain an item list');
  return items.map(record);
}

const dnsName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
export function resourceName(resource: Resource, kind: string, namespace: string): string {
  const spec = record(resource.spec), meta = record(spec.metadata);
  if (resource.provider !== 'kubernetes' || spec.kind !== kind || spec.apiVersion !== (kind === 'Deployment' ? 'apps/v1' : 'v1')
    || meta.namespace !== namespace || typeof meta.name !== 'string' || !dnsName.test(meta.name) || meta.name.length > 253) {
    throw new Error('Connection checks support explicit same-namespace Kubernetes Service to Deployment resources');
  }
  return meta.name;
}
export function selector(value: unknown): Record<string, string> {
  const values = record(value);
  if (!Object.keys(values).length || Object.entries(values).some(([key, val]) => !key || typeof val !== 'string' || !val)) {
    throw new Error('Connection checks require explicit nonempty label selectors');
  }
  return values as Record<string, string>;
}
function identifies(value: ObjectValue, kind: string, name: string, namespace: string): ObjectValue {
  const meta = record(value.metadata);
  if (value.kind !== kind || meta.name !== name || meta.namespace !== namespace || !identity(meta.uid)
    || meta.deletionTimestamp) throw new Error(`Connection resource identity changed: ${kind}/${name}`);
  return meta;
}
function owned(value: ObjectValue, resource: Resource, stack: string, namespace: string): ObjectValue {
  const meta = identifies(value, String(resource.spec.kind), String(record(resource.spec.metadata).name), namespace);
  const annotations = record(meta.annotations);
  if (annotations['footprint-iac.dev/owner'] !== fingerprint({ stack, id: resource.id })
    || annotations['footprint-iac.dev/stack'] !== stack || annotations['footprint-iac.dev/resource'] !== resource.id) {
    throw new Error(`Connection resource is no longer owned: ${resource.id}`);
  }
  return meta;
}
const owner = (meta: ObjectValue, kind: string, uid: string) => Array.isArray(meta.ownerReferences)
  && meta.ownerReferences.some((item: ObjectValue) => item.kind === kind && item.uid === uid && item.controller === true);
const matches = (labels: ObjectValue, required: Record<string, string>) => Object.entries(required).every(([key, val]) => labels[key] === val);

export interface RouteSnapshot {
  serviceUID: string; deploymentUID: string; clusterIPs: string[]; servicePort: number; targetPort: string | number;
  sourcePod: { name: string; uid: string; ip: string }; backendPods: { name: string; uid: string; ip: string }[];
  endpointPorts: number[]; selector: Record<string, string>;
}

/** Verify that every advertised ready backend belongs to the desired Deployment before trusting a probe. */
export function inspectRoute(input: {
  service: ObjectValue; deployment: ObjectValue; replicaSets: ObjectValue[]; pods: ObjectValue[]; endpointSlices: ObjectValue[];
  from: Resource; to: Resource; stack: string; namespace: string; container: string;
}): RouteSnapshot {
  const { service, deployment, namespace } = input;
  const sm = owned(service, input.from, input.stack, namespace), dm = owned(deployment, input.to, input.stack, namespace);
  const spec = record(service.spec), desired = record(input.from.spec.spec);
  if ((spec.type ?? 'ClusterIP') !== 'ClusterIP' || spec.clusterIP === 'None' || !isIP(spec.clusterIP ?? '')
    || spec.externalName || spec.externalIPs?.length || spec.publishNotReadyAddresses === true) {
    throw new Error('Connection checks require an ordinary internal ClusterIP Service');
  }
  const serviceSelector = selector(spec.selector);
  if (canonical(serviceSelector) !== canonical(selector(desired.selector))) throw new Error('Service selector differs from the declared connection');
  const ports = spec.ports, desiredPorts = desired.ports;
  if (!Array.isArray(ports) || ports.length !== 1 || !Array.isArray(desiredPorts) || desiredPorts.length !== 1
    || (ports[0].protocol ?? 'TCP') !== 'TCP' || ports[0].port !== desiredPorts[0].port
    || !Number.isInteger(ports[0].port) || ports[0].port < 1 || ports[0].port > 65535) {
    throw new Error('Connection checks require one declared TCP Service port');
  }
  const clusterIPs: string[] = spec.clusterIPs ?? [spec.clusterIP];
  if (!Array.isArray(clusterIPs) || !clusterIPs.length || clusterIPs.some(ip => typeof ip !== 'string' || !isIP(ip))
    || !clusterIPs.includes(spec.clusterIP)) throw new Error('Service ClusterIP addresses are invalid');
  const ds = record(deployment.spec), dsSelector = record(ds.selector);
  if (dsSelector.matchExpressions?.length) throw new Error('Deployment expression selectors are unsupported by this connection checker');
  const deploymentSelector = selector(dsSelector.matchLabels);
  const desiredSelector = selector(record(input.to.spec.spec).selector.matchLabels);
  if (canonical(deploymentSelector) !== canonical(desiredSelector)) throw new Error('Deployment selector differs from the declared connection');
  const template = record(ds.template), desiredTemplate = record(record(input.to.spec.spec).template);
  const actualContainers = record(template.spec).containers, desiredContainers = record(desiredTemplate.spec).containers;
  if (!Array.isArray(actualContainers) || !Array.isArray(desiredContainers)
    || !desiredContainers.some(c => c.name === input.container)
    || desiredContainers.some(c => !actualContainers.some(a => a.name === c.name && a.image === c.image))) {
    throw new Error('The probe container does not match the declared Deployment images');
  }
  const status = record(deployment.status);
  const replicas = ds.replicas ?? 1;
  if (!Number.isInteger(replicas) || replicas < 1 || !Number.isInteger(dm.generation) || dm.generation < 1
    || !Number.isInteger(status.observedGeneration) || status.observedGeneration < dm.generation
    || !Number.isInteger(status.updatedReplicas) || status.updatedReplicas !== replicas
    || !Number.isInteger(status.availableReplicas) || status.availableReplicas < replicas
    || !Number.isInteger(status.replicas) || status.replicas !== replicas) throw new Error('Connection target Deployment is not ready');
  const replicaSetUIDs = new Set(input.replicaSets.filter(rs => {
    const meta = record(rs.metadata);
    if (meta.namespace !== namespace || meta.deletionTimestamp || !owner(meta, 'Deployment', dm.uid)) return false;
    if (!identity(meta.uid)) throw new Error('Target ReplicaSet identity is unavailable');
    return true;
  }).map(rs => record(rs.metadata).uid));
  const pods = input.pods.filter(pod => {
    const meta = record(pod.metadata), podStatus = record(pod.status), podSpec = record(pod.spec);
    return meta.namespace === namespace && !meta.deletionTimestamp
      && [...replicaSetUIDs].some(uid => owner(meta, 'ReplicaSet', uid))
      && identity(meta.uid) && typeof meta.name === 'string' && dnsName.test(meta.name)
      && typeof podStatus.podIP === 'string' && isIP(podStatus.podIP) > 0
      && matches(record(meta.labels), deploymentSelector) && matches(record(meta.labels), serviceSelector) && podStatus.phase === 'Running'
      && podStatus.conditions?.some((c: ObjectValue) => c.type === 'Ready' && c.status === 'True')
      && podStatus.containerStatuses?.some((c: ObjectValue) => c.name === input.container && c.ready === true)
      && podSpec.containers?.some((c: ObjectValue) => c.name === input.container && desiredContainers.some(d => d.name === c.name && d.image === c.image));
  });
  const byUID = new Map(pods.map(pod => [record(pod.metadata).uid, pod]));
  const backendPods = new Map<string, { name: string; uid: string; ip: string }>();
  const endpointPorts = new Set<number>();
  if (!input.endpointSlices.length) throw new Error('Service has no EndpointSlices');
  for (const slice of input.endpointSlices) {
    const meta = record(slice.metadata);
    if (meta.namespace !== namespace || meta.labels?.['kubernetes.io/service-name'] !== sm.name || meta.deletionTimestamp
      || !meta.ownerReferences?.some((ref: ObjectValue) => ref.kind === 'Service' && ref.uid === sm.uid)) {
      throw new Error('EndpointSlice does not belong to the observed Service');
    }
    if (!Array.isArray(slice.ports) || !slice.ports.length || slice.ports.some((p: ObjectValue) => (p.protocol ?? 'TCP') !== 'TCP'
      || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) throw new Error('Service endpoint ports are invalid');
    for (const port of slice.ports) endpointPorts.add(port.port);
    if (!Array.isArray(slice.endpoints)) throw new Error('Service EndpointSlice endpoints are invalid');
    for (const endpoint of slice.endpoints) {
      if (endpoint.conditions?.ready !== true || endpoint.conditions?.terminating === true) throw new Error('Service advertises an unready backend');
      const ref = record(endpoint.targetRef), pod = byUID.get(ref.uid);
      if (!identity(ref.uid) || !pod || ref.kind !== 'Pod' || ref.namespace !== namespace || record(pod.metadata).name !== ref.name) {
        throw new Error('Service backend is not a ready pod owned by the desired Deployment');
      }
      const pmeta = record(pod.metadata), pstatus = record(pod.status);
      const podIPs = new Set([pstatus.podIP, ...(pstatus.podIPs ?? []).map((p: ObjectValue) => p.ip)]);
      if (!Array.isArray(endpoint.addresses) || !endpoint.addresses.length || endpoint.addresses.some((ip: string) => !isIP(ip) || !podIPs.has(ip))) {
        throw new Error('Service backend addresses do not match the observed target pod');
      }
      for (const ip of endpoint.addresses) backendPods.set(pmeta.uid + ':' + ip, { name: pmeta.name, uid: pmeta.uid, ip });
    }
  }
  const backends = [...backendPods.values()].sort((a, b) => a.uid.localeCompare(b.uid) || a.ip.localeCompare(b.ip));
  if (!backends.length) throw new Error('Service has no ready owned backends');
  const source = backends[0]!, sourcePod = byUID.get(source.uid)!;
  return { serviceUID: sm.uid, deploymentUID: dm.uid, clusterIPs: [...clusterIPs].sort(),
    servicePort: ports[0].port, targetPort: ports[0].targetPort ?? ports[0].port,
    sourcePod: { name: source.name, uid: source.uid, ip: record(sourcePod.status).podIP },
    backendPods: backends, endpointPorts: [...endpointPorts].sort((a, b) => a - b), selector: serviceSelector };
}

export function routeDetails(route: RouteSnapshot): JsonObject { return JSON.parse(JSON.stringify(route)); }

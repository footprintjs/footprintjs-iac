import { compileGraph } from '../graph/compile.ts';
import type { JsonObject, Resource } from '../types.ts';
import { fingerprint } from '../util.ts';
import type { InfraGraph } from '../graph/types.ts';
import type { KubernetesWorkloadInput } from './types.ts';
import { asJson, image, integer, key, list, name, object, port, protocol, quantity, relativePath, targetPort, unique } from './validation.ts';

function reference(value: unknown): JsonObject {
  const ref = object(value, ['name', 'key'], 'environment key reference');
  return { name: name(ref.name), key: key(ref.key) };
}

function probe(value: unknown): JsonObject {
  const input = object(value, ['httpGet', 'tcpSocket', 'initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'failureThreshold'], 'probe');
  if (Number(input.httpGet !== undefined) + Number(input.tcpSocket !== undefined) !== 1) throw new Error('A probe requires exactly one HTTP or TCP check.');
  const result: JsonObject = {};
  if (input.httpGet !== undefined) {
    const http = object(input.httpGet, ['path', 'port'], 'HTTP probe');
    if (typeof http.path !== 'string' || !http.path.startsWith('/') || http.path.startsWith('//') || http.path.length > 2048 || /[\x00-\x20\x7f#]/.test(http.path)) throw new Error('Invalid HTTP probe path.');
    result.httpGet = { path: http.path, port: targetPort(http.port) };
  } else {
    const tcp = object(input.tcpSocket, ['port'], 'TCP probe');
    result.tcpSocket = { port: targetPort(tcp.port) };
  }
  for (const field of ['initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'failureThreshold'] as const) {
    if (input[field] !== undefined) result[field] = integer(input[field], field === 'initialDelaySeconds' ? 0 : 1, 86400, field);
  }
  return result;
}

function resources(value: unknown): JsonObject {
  const input = object(value, ['requests', 'limits'], 'container resources');
  const result: JsonObject = {};
  for (const field of ['requests', 'limits'] as const) if (input[field] !== undefined) {
    const quantities = object(input[field], ['cpu', 'memory'], 'resource quantities');
    result[field] = Object.fromEntries(Object.entries(quantities).map(([key, value]) => [key, quantity(value)]));
  }
  return result;
}

function strategy(value: unknown): JsonObject {
  const input = object(value, ['type', 'rollingUpdate'], 'deployment strategy');
  if (input.type === 'Recreate') {
    if (input.rollingUpdate !== undefined) throw new Error('Recreate does not permit rollingUpdate settings.');
    return { type: 'Recreate' };
  }
  if (input.type !== 'RollingUpdate') throw new Error('Unsupported deployment strategy.');
  if (input.rollingUpdate === undefined) return { type: 'RollingUpdate' };
  const rolling = object(input.rollingUpdate, ['maxSurge', 'maxUnavailable'], 'rollingUpdate settings');
  const amount = (value: unknown): number | string => typeof value === 'string' && /^(?:0|[1-9][0-9]?|100)%$/.test(value) ? value : integer(value, 0, 10000, 'rollout amount');
  const maxSurge = amount(rolling.maxSurge), maxUnavailable = amount(rolling.maxUnavailable);
  if (['0', '0%'].includes(String(maxSurge)) && ['0', '0%'].includes(String(maxUnavailable))) throw new Error('RollingUpdate requires a positive surge or unavailable budget.');
  return { type: 'RollingUpdate', rollingUpdate: { maxSurge, maxUnavailable } };
}

export function lowerWorkloadVolume(value: unknown): JsonObject {
  const input = object(value, ['name', 'secret', 'configMap', 'emptyDir', 'persistentVolumeClaim'], 'volume');
  const result: JsonObject = { name: name(input.name) };
  const sources = ['secret', 'configMap', 'emptyDir', 'persistentVolumeClaim'].filter(field => input[field] !== undefined);
  if (sources.length !== 1) throw new Error('A volume requires exactly one existing Secret, ConfigMap, PVC or temporary emptyDir source.');
  const field = sources[0]!;
  if (field === 'emptyDir') {
    const temporary = object(input.emptyDir, ['medium', 'sizeLimit'], 'emptyDir');
    const source: JsonObject = {};
    if (temporary.medium !== undefined) {
      if (temporary.medium !== 'Memory') throw new Error('Unsupported emptyDir medium.');
      source.medium = 'Memory';
    }
    if (temporary.sizeLimit !== undefined) source.sizeLimit = quantity(temporary.sizeLimit);
    result.emptyDir = source;
  } else if (field === 'persistentVolumeClaim') {
    const source = object(input[field], ['claimName', 'readOnly'], 'existing PVC source');
    if (source.readOnly !== undefined && typeof source.readOnly !== 'boolean') throw new Error('Invalid PVC readOnly flag.');
    result.persistentVolumeClaim = { claimName: name(source.claimName), ...(source.readOnly === undefined ? {} : { readOnly: source.readOnly }) };
  } else {
    const sourceName = field === 'secret' ? 'secretName' : 'name';
    const source = object(input[field], [sourceName, 'items'], 'external volume source');
    const projected: JsonObject = { [sourceName]: name(source[sourceName]) };
    if (source.items !== undefined) {
      projected.items = list(source.items, 'volume items').map(item => {
        const entry = object(item, ['key', 'path'], 'volume item');
        return { key: key(entry.key), path: relativePath(entry.path) };
      });
      unique((projected.items as JsonObject[]).map(item => String(item.path)), 'volume item paths');
    }
    result[field] = projected;
  }
  return result;
}

/** Pure compilation: no provider discovery, credential lookup, image build or cluster calls. */
export function lowerKubernetesWorkloadGraph(value: KubernetesWorkloadInput): InfraGraph {
  const input = object(value, ['stack', 'namespace', 'name', 'replicas', 'containers', 'service', 'imagePullSecrets', 'volumes', 'podSecurityContext', 'deploymentStrategy'], 'workload options');
  if (typeof input.stack !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.stack)) throw new Error('Invalid workload stack.');
  const stack = input.stack, namespace = name(input.namespace, 'existing namespace'), workloadName = name(input.name, 'workload name');
  const volumes = input.volumes === undefined ? [] : list(input.volumes, 'volumes', true).map(lowerWorkloadVolume);
  unique(volumes.map(item => String(item.name)), 'volume names');
  const containers = list(input.containers, 'containers').map(value => {
    const input = object(value, ['name', 'image', 'ports', 'env', 'volumeMounts', 'readinessProbe', 'livenessProbe', 'startupProbe', 'resources', 'securityContext'], 'container');
    const container: JsonObject = { name: name(input.name, 'container name'), image: image(input.image) };
    if (input.ports !== undefined) container.ports = list(input.ports, 'container ports', true).map(value => {
      const entry = object(value, ['name', 'containerPort', 'protocol'], 'container port');
      return { containerPort: port(entry.containerPort), protocol: protocol(entry.protocol), ...(entry.name === undefined ? {} : { name: name(entry.name, 'port name') }) };
    });
    if (input.env !== undefined) {
      if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env)) throw new Error('Invalid environment references.');
      container.env = Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)).map(([envName, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,252}$/.test(envName)) throw new Error('Invalid environment variable name.');
        const entry = object(value, ['secretKeyRef', 'configMapKeyRef'], 'environment reference');
        const sources = ['secretKeyRef', 'configMapKeyRef'].filter(field => entry[field] !== undefined);
        if (sources.length !== 1) throw new Error('Environment entries require one external key reference.');
        return { name: envName, valueFrom: { [sources[0]!]: reference(entry[sources[0]!]) } };
      });
    }
    if (input.volumeMounts !== undefined) {
      container.volumeMounts = list(input.volumeMounts, 'volume mounts', true).map(value => {
        const mount = object(value, ['name', 'mountPath', 'readOnly', 'subPath'], 'volume mount');
        const volumeName = name(mount.name);
        if (!volumes.some(entry => entry.name === volumeName)) throw new Error('Volume mount refers to an undeclared volume.');
        if (typeof mount.mountPath !== 'string' || !mount.mountPath.startsWith('/') || mount.mountPath.length > 1024 || /[\x00-\x1f\x7f]/.test(mount.mountPath)
          || mount.mountPath.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid volume mount path.');
        if (mount.readOnly !== undefined && typeof mount.readOnly !== 'boolean') throw new Error('Invalid readOnly flag.');
        const mounted = volumes.find(entry => entry.name === volumeName)!;
        if ((mounted.secret || mounted.configMap) && mount.readOnly === false) throw new Error('External configuration volumes must be mounted read-only.');
        return { name: volumeName, mountPath: mount.mountPath,
          ...((mounted.secret || mounted.configMap || mount.readOnly !== undefined) ? { readOnly: mount.readOnly ?? true } : {}),
          ...(mount.subPath === undefined ? {} : { subPath: relativePath(mount.subPath) }) };
      });
    }
    for (const field of ['readinessProbe', 'livenessProbe', 'startupProbe'] as const) if (input[field] !== undefined) container[field] = probe(input[field]);
    if (input.resources !== undefined) container.resources = resources(input.resources);
    const security = input.securityContext === undefined ? {} : object(input.securityContext, ['runAsUser', 'runAsGroup', 'readOnlyRootFilesystem'], 'container security context');
    if (security.readOnlyRootFilesystem !== undefined && typeof security.readOnlyRootFilesystem !== 'boolean') throw new Error('Invalid readOnlyRootFilesystem flag.');
    container.securityContext = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true,
      readOnlyRootFilesystem: security.readOnlyRootFilesystem ?? true, seccompProfile: { type: 'RuntimeDefault' },
      ...(security.runAsUser === undefined ? {} : { runAsUser: integer(security.runAsUser, 1, 2147483647, 'runAsUser') }),
      ...(security.runAsGroup === undefined ? {} : { runAsGroup: integer(security.runAsGroup, 1, 2147483647, 'runAsGroup') }) };
    return container;
  });
  unique(containers.map(item => String(item.name)), 'container names');
  const declaredPorts = containers.flatMap(container => container.ports as JsonObject[] ?? []);
  unique(declaredPorts.filter(entry => entry.name !== undefined).map(entry => String(entry.name)), 'named container ports');
  const labels = { 'app.kubernetes.io/name': workloadName, 'app.kubernetes.io/instance': fingerprint({ stack, name: workloadName }).slice(0, 16) };
  const pod: JsonObject = { containers, automountServiceAccountToken: false, ...(volumes.length ? { volumes } : {}) };
  if (input.podSecurityContext !== undefined) {
    const security = object(input.podSecurityContext, ['fsGroup', 'fsGroupChangePolicy'], 'pod security context');
    if (security.fsGroupChangePolicy !== undefined && !['OnRootMismatch', 'Always'].includes(String(security.fsGroupChangePolicy))) throw new Error('Unsupported fsGroupChangePolicy.');
    pod.securityContext = { ...(security.fsGroup === undefined ? {} : { fsGroup: integer(security.fsGroup, 1, 2147483647, 'fsGroup') }),
      ...(security.fsGroupChangePolicy === undefined ? {} : { fsGroupChangePolicy: security.fsGroupChangePolicy as string }) };
  }
  if (input.imagePullSecrets !== undefined) {
    const secrets = list(input.imagePullSecrets, 'image pull secrets', true).map(value => name(value));
    unique(secrets, 'image pull secrets');
    pod.imagePullSecrets = secrets.map(name => ({ name }));
  }
  const deployment: Resource = { id: `${workloadName}-deployment`, provider: 'kubernetes', spec: {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: workloadName, namespace }, spec: {
      replicas: input.replicas === undefined ? 1 : integer(input.replicas, 1, 10000, 'replicas'),
      strategy: input.deploymentStrategy === undefined ? { type: 'Recreate' } : strategy(input.deploymentStrategy),
      selector: { matchLabels: labels }, template: { metadata: { labels }, spec: pod },
    },
  } };
  const managed: Resource[] = [deployment];
  const relations: { from: string; to: string; kind: 'communicatesWith' }[] = [];
  if (input.service !== undefined) {
    const service = object(input.service, ['name', 'ports'], 'ClusterIP service');
    const ports = list(service.ports, 'service ports').map(value => {
      const entry = object(value, ['name', 'port', 'targetPort', 'protocol'], 'service port');
      const target = targetPort(entry.targetPort), transport = protocol(entry.protocol);
      if (!declaredPorts.some(item => (typeof target === 'string' ? item.name === target : item.containerPort === target) && item.protocol === transport)) throw new Error('Service targetPort must match a declared container port and protocol.');
      return { port: port(entry.port), targetPort: target, protocol: transport, ...(entry.name === undefined ? {} : { name: name(entry.name, 'service port name') }) };
    });
    if (ports.length > 1 && ports.some(entry => !entry.name)) throw new Error('Multiple Service ports require names.');
    unique(ports.map(entry => `${entry.protocol}:${entry.port}`), 'service ports');
    unique(ports.filter(entry => entry.name).map(entry => String(entry.name)), 'service port names');
    const serviceResource: Resource = { id: `${workloadName}-service`, provider: 'kubernetes', spec: {
      apiVersion: 'v1', kind: 'Service', metadata: { name: service.name === undefined ? workloadName : name(service.name), namespace },
      spec: { type: 'ClusterIP', selector: labels, ports },
    } };
    managed.push(serviceResource);
    relations.push({ from: serviceResource.id, to: deployment.id, kind: 'communicatesWith' });
  }
  const graph = compileGraph({ name: stack, resources: managed, boundaries: [], memberships: [], relations });
  return graph;
}

import type { JsonObject, Resource } from '../types.ts';
import { fingerprint } from '../util.ts';
import { lowerKubernetesWorkloadGraph } from './lowering.ts';
import type { KubernetesWorkloadContainer, KubernetesWorkloadInput } from './types.ts';
import { integer, list, name, object, port, protocol, targetPort, unique } from './validation.ts';

function labels(value: unknown, stack: string): { 'app.kubernetes.io/name': string; 'app.kubernetes.io/instance': string } {
  const declared = object(value, ['app.kubernetes.io/name', 'app.kubernetes.io/instance'], 'workload selector');
  const workloadName = name(declared['app.kubernetes.io/name']);
  const expected = { 'app.kubernetes.io/name': workloadName, 'app.kubernetes.io/instance': fingerprint({ stack, name: workloadName }).slice(0, 16) };
  if (fingerprint(declared) !== fingerprint(expected)) throw new Error('Workload selector differs from its compiled stack identity.');
  return expected;
}

/** Rebuild the compiler output from an untrusted graph, rather than accepting nested manifest bags. */
export function assertWorkloadManifest(resource: Resource, namespace: string, stack: string): void {
  if (resource.provider !== 'kubernetes') throw new Error('Workload graph supports only the Kubernetes provider.');
  const manifest = object(resource.spec, ['apiVersion', 'kind', 'metadata', 'spec'], 'workload manifest');
  const metadata = object(manifest.metadata, ['name', 'namespace'], 'workload metadata');
  const resourceName = name(metadata.name);
  if (metadata.namespace !== namespace) throw new Error('Workload resource escapes its registered namespace.');
  if (manifest.kind === 'Service' && manifest.apiVersion === 'v1') {
    const spec = object(manifest.spec, ['type', 'selector', 'ports'], 'ClusterIP service specification');
    if (spec.type !== 'ClusterIP') throw new Error('Workload profile supports only ClusterIP Services.');
    const selector = labels(spec.selector, stack);
    const ports = list(spec.ports, 'service ports').map(value => {
      const input = object(value, ['name', 'port', 'targetPort', 'protocol'], 'service port');
      return { port: port(input.port), targetPort: targetPort(input.targetPort), protocol: protocol(input.protocol), ...(input.name === undefined ? {} : { name: name(input.name) }) };
    });
    if (ports.length > 1 && ports.some(entry => !entry.name)) throw new Error('Multiple Service ports require names.');
    unique(ports.map(entry => `${entry.protocol}:${entry.port}`), 'service ports');
    unique(ports.filter(entry => entry.name).map(entry => String(entry.name)), 'service port names');
    const expected = { apiVersion: 'v1', kind: 'Service', metadata: { name: resourceName, namespace }, spec: { type: 'ClusterIP', selector, ports } };
    if (fingerprint(resource.spec) !== fingerprint(expected)) throw new Error('Service manifest is not canonical workload compiler output.');
    return;
  }
  if (manifest.kind !== 'Deployment' || manifest.apiVersion !== 'apps/v1') throw new Error('Workload profile supports only Deployment and ClusterIP Service resources.');
  const spec = object(manifest.spec, ['replicas', 'strategy', 'selector', 'template'], 'Deployment specification');
  const template = object(spec.template, ['metadata', 'spec'], 'pod template');
  const pod = object(template.spec, ['containers', 'volumes', 'imagePullSecrets', 'automountServiceAccountToken', 'securityContext'], 'pod specification');
  if (pod.automountServiceAccountToken !== false) throw new Error('Workload profile requires automountServiceAccountToken false.');
  const containers = list(pod.containers, 'containers').map(value => {
    const input = object(value, ['name', 'image', 'ports', 'env', 'volumeMounts', 'readinessProbe', 'livenessProbe', 'startupProbe', 'resources', 'securityContext'], 'container');
    const security = object(input.securityContext, ['allowPrivilegeEscalation', 'capabilities', 'runAsNonRoot', 'readOnlyRootFilesystem', 'seccompProfile', 'runAsUser', 'runAsGroup'], 'container security context');
    const capabilities = object(security.capabilities, ['drop'], 'container capabilities');
    const seccomp = object(security.seccompProfile, ['type'], 'container seccomp profile');
    if (security.allowPrivilegeEscalation !== false || security.runAsNonRoot !== true || typeof security.readOnlyRootFilesystem !== 'boolean'
      || fingerprint(capabilities.drop) !== fingerprint(['ALL']) || seccomp.type !== 'RuntimeDefault') throw new Error('Workload security context must preserve non-root execution and dropped capabilities.');
    const env: Record<string, unknown> = {};
    if (input.env !== undefined) for (const value of list(input.env, 'environment entries', true)) {
      const entry = object(value, ['name', 'valueFrom'], 'environment entry');
      if (typeof entry.name !== 'string' || Object.hasOwn(env, entry.name)) throw new Error('Duplicate or invalid environment variable name.');
      env[entry.name] = entry.valueFrom;
    }
    return { name: input.name, image: input.image,
      ...(input.ports === undefined ? {} : { ports: input.ports }),
      ...(input.env === undefined ? {} : { env }),
      ...(input.volumeMounts === undefined ? {} : { volumeMounts: input.volumeMounts }),
      ...(input.readinessProbe === undefined ? {} : { readinessProbe: input.readinessProbe }),
      ...(input.livenessProbe === undefined ? {} : { livenessProbe: input.livenessProbe }),
      ...(input.startupProbe === undefined ? {} : { startupProbe: input.startupProbe }),
      ...(input.resources === undefined ? {} : { resources: input.resources }),
      securityContext: { readOnlyRootFilesystem: security.readOnlyRootFilesystem,
        ...(security.runAsUser === undefined ? {} : { runAsUser: security.runAsUser }),
        ...(security.runAsGroup === undefined ? {} : { runAsGroup: security.runAsGroup }) },
    } as KubernetesWorkloadContainer;
  });
  const pullSecrets = pod.imagePullSecrets === undefined ? undefined : list(pod.imagePullSecrets, 'image pull secrets', true).map(value => {
    const ref = object(value, ['name'], 'image pull secret'); return name(ref.name);
  });
  const rebuilt = lowerKubernetesWorkloadGraph({ stack, namespace, name: resourceName,
    replicas: integer(spec.replicas, 1, 10000, 'replicas'), deploymentStrategy: spec.strategy as KubernetesWorkloadInput['deploymentStrategy'], containers,
    ...(pod.volumes === undefined ? {} : { volumes: pod.volumes as KubernetesWorkloadInput['volumes'] }),
    ...(pullSecrets === undefined ? {} : { imagePullSecrets: pullSecrets }),
    ...(pod.securityContext === undefined ? {} : { podSecurityContext: pod.securityContext as KubernetesWorkloadInput['podSecurityContext'] }),
  });
  if (fingerprint(resource.spec) !== fingerprint(rebuilt.resources[0]!.spec)) throw new Error('Deployment manifest is not canonical workload compiler output.');
}

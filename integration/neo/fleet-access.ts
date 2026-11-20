import { bindSystem, type BindingProfile, type CapabilityAdapter, type LoweredCapability } from '../../src/binding/index.ts';
import { artifact, system, type ServiceHandle, type StoreHandle } from '../../src/system/index.ts';
import type { Capability } from '../../src/system/types.ts';
import type { JsonObject } from '../../src/types.ts';
import { canonical } from '../../src/util.ts';

export const fleetPath = '/run/neo-fleet/manifest.json';
export const fleetManifest = {
  v: 1, swept_at: '2026-11-15T03:15:59Z', windows: { short: '2h', long: '26h' },
  influx: { buckets: [{ bucket: 'local', errors: [], measurements: [{
    measurement: 'SwitchPortCounters', window: '2h', state: 'points in window', cadence_seconds: 300, cadence_longest_gap_seconds: 301,
    fields: [{ field: 'value', latest: '2026-11-15T03:13:00Z' }], tag_keys: [],
  }] }], errors: [] }, sqlite: [],
};
const program = artifact('neo-fleet');
const stores = [{ ref: { kind: 'store', path: 'state.fleet' }, access: 'read' }];

export function fleetDesign(access?: 'read' | 'write' | 'readWrite') {
  const app = system('neo-fleet');
  let store!: StoreHandle, service!: ServiceHandle;
  app.addStorage('state', state => { store = state.store('fleet', file => file.dataModel('file')); });
  app.addCompute('application', application => {
    service = application.service('neo', workload => {
      workload.program(program);
      if (access) workload.uses(store, access);
    });
  });
  return { design: app.build(), store, service };
}

type Target = { kind: 'kubernetes'; namespace: string } | { kind: 'docker'; source: string };
export function bindFleet(target: Target, image: string, access?: 'read' | 'write' | 'readWrite') {
  const declared = fleetDesign(access);
  return { ...declared, binding: bindSystem(declared.design, fleetProfile(target, image)) };
}

function fleetProfile(target: Target, image: string): BindingProfile {
  const reason = target.kind === 'kubernetes'
    ? 'Neo requested read access to the Fleet manifest. Kubernetes mounts the ConfigMap read-only for Neo.'
    : 'Neo requested read access to the Fleet manifest. Docker makes the bind mount read-only for Neo.';
  const adapter: CapabilityAdapter = {
    id: `neo-fleet-${target.kind}`, mode: 'real',
    supports(capability) {
      const requirements = Object.entries(capability.properties).map(([property, requested]) => ({
        property, requested, status: 'implemented' as const,
        reason: property === 'stores' ? reason : property === 'program' ? 'Runs the supplied Neo image.' : 'Uses a file-backed Fleet manifest.',
      }));
      const unsupportedRequirements = requirements.filter(({ property, requested }) => {
        if (capability.kind === 'store') return property !== 'dataModel' || requested !== 'file';
        if (property === 'program') return canonical(requested) !== canonical(program);
        return property !== 'stores' || canonical(requested) !== canonical(stores);
      }).map(row => row.property);
      return { supported: unsupportedRequirements.length === 0, requirements, unsupportedRequirements,
        reason: 'This Fleet example supports only its file-backed manifest and read access.' };
    },
    lower(capability, context) {
      const id = context.resourceId();
      return target.kind === 'kubernetes'
        ? lowerKubernetes(capability, id, target.namespace, image)
        : lowerDocker(capability, id, target.source, image);
    },
  };
  return { id: `neo-fleet-${target.kind}`, target: { id: target.kind, properties: { ...target } },
    artifacts: { [program.id]: { image } }, adapters: [adapter],
    rules: [{ id: 'fleet-store', family: 'storage', kind: 'store', adapterId: adapter.id },
      { id: 'fleet-service', family: 'compute', kind: 'service', adapterId: adapter.id }] };
}

function neoEnvironment(read: boolean): JsonObject {
  return { BE_SERVER_HOST: '0.0.0.0', BE_SERVER_PORT: '5230', NODE_ENV: 'development', SEO_LOCAL_AUTH: '1', PY_TOOLS: '0', SEO_MCP: '0',
    ...(read && { SEO_FLEET_MANIFEST: fleetPath }) };
}

function lowerKubernetes(capability: Capability, id: string, namespace: string, image: string): LoweredCapability {
  if (capability.kind === 'store') return { resources: [{
    id, provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'fleet', namespace },
      data: { 'manifest.json': JSON.stringify(fleetManifest) } },
  }] };
  const read = capability.properties.stores !== undefined;
  const labels = { app: 'neo-fleet' };
  const env = Object.entries(neoEnvironment(read)).map(([name, value]) => ({ name, value }));
  const spec = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'neo', namespace },
    spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      automountServiceAccountToken: false,
      containers: [{ name: 'neo', image, imagePullPolicy: 'Never', env,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] } },
        ports: [{ containerPort: 5230 }], readinessProbe: { httpGet: { path: '/health', port: 5230 }, periodSeconds: 2 },
        ...(read && { volumeMounts: [{ name: 'fleet', mountPath: '/run/neo-fleet', readOnly: true }] }),
      }],
      ...(read && { volumes: [{ name: 'fleet', configMap: { name: 'fleet' } }] }),
    } } } };
  return { resources: [{ id, provider: 'kubernetes', spec }], propertyOrigins: read
    ? ['/spec/template/spec/containers/0/volumeMounts', `/spec/template/spec/containers/0/env/${env.length - 1}`, '/spec/template/spec/volumes']
      .map(path => ({ property: 'stores', resourceId: id, path })) : [] };
}

function lowerDocker(capability: Capability, id: string, source: string, image: string): LoweredCapability {
  if (capability.kind === 'store') return { resources: [{ id, provider: 'docker', spec: { kind: 'existingFile', source } }] };
  const read = capability.properties.stores !== undefined;
  return { resources: [{ id, provider: 'docker', spec: { kind: 'container', image, environment: neoEnvironment(read),
    ...(read && { mount: { source, target: fleetPath, readOnly: true } }),
  } }], propertyOrigins: read ? ['/mount', '/environment/SEO_FLEET_MANIFEST']
    .map(path => ({ property: 'stores', resourceId: id, path })) : [] };
}

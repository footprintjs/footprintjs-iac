import { canonical } from '../util.ts';
import type { Capability } from '../system/types.ts';
import type { Json, JsonObject, Resource } from '../types.ts';
import type { BindingProfile, CapabilityAdapter, LoweringContext } from './types.ts';
import { simulationSupport } from './simulation-support.ts';
import { slots } from './data.ts';
import { readProfile } from './profile.ts';

function referenced(context: LoweringContext, reference: Json) {
  const mapping = context.mapping(reference);
  return { capabilityId: mapping.capabilityId, resourceIds: mapping.exitPoints };
}
/** Provider inputs contain stable resolved references; display paths stay in origin metadata. */
function operationalProperties(capability: Capability): JsonObject {
  const properties: JsonObject = {};
  for (const [key, value] of Object.entries(capability.properties)) {
    if (['program', 'networks', 'stores', 'runAs', 'target'].includes(key)) continue;
    if (key === 'retention') {
      const retention = { ...(value as JsonObject) };
      delete retention.onRemoval;
      if (Object.keys(retention).length) properties.retention = retention;
    } else properties[key] = value;
  }
  return properties;
}
function baseSpec(capability: Capability, context: LoweringContext): JsonObject {
  return {
    kind: 'simulated-' + capability.kind,
    bindingTarget: context.target as unknown as JsonObject,
    simulation: true,
    guarantees: 'No live compute, data durability, networking, authorization or schedule is verified.',
    capability: { id: capability.id, family: capability.family, kind: capability.kind },
    properties: operationalProperties(capability),
  };
}
function lower(capability: Capability, context: LoweringContext) {
  const base = baseSpec(capability, context);
  if (capability.family === 'storage') {
    const config = context.resourceId('configuration');
    const copies = Number((capability.properties.replication as JsonObject | undefined)?.copies ?? 1);
    const retention = capability.properties.retention as JsonObject | undefined;
    const lifecycle = retention?.onRemoval === undefined ? undefined : { retainOnRemoval: retention.onRemoval === 'retain' };
    const resources: Resource[] = [{ id: config, provider: 'simulator', spec: { ...base, role: 'configuration' } }];
    for (let index = 1; index <= copies; index++) resources.push({
      id: context.resourceId('replica-' + index), provider: 'simulator', dependsOn: [config],
      spec: { ...base, role: 'simulated-data-copy', copy: index, copies },
      ...(lifecycle === undefined ? {} : { lifecycle }),
    });
    return { resources };
  }
  if (capability.family === 'compute') {
    const program = context.artifact(capability.properties.program);
    const attachments = (capability.properties.networks as Json[] | undefined ?? [])
      .map(reference => referenced(context, reference)).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const stores = (capability.properties.stores as JsonObject[] | undefined ?? []).map(use => ({
      ...referenced(context, use.ref!), access: use.access!,
    })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const principal = capability.properties.runAs === undefined ? undefined : context.principal(capability.properties.runAs);
    const replicas = Number(capability.properties.replicas ?? 1);
    const resources: Resource[] = [];
    for (let instance = 1; instance <= replicas; instance++) resources.push({
      id: context.resourceId('instance-' + instance), provider: 'simulator',
      spec: { ...base, instance, program, attachments, stores,
        ...(principal ? { principal: { id: principal.id, properties: principal.properties, authorization: 'simulated only' } } : {}) },
    });
    return { resources };
  }
  const target = capability.properties.target === undefined ? undefined : referenced(context, capability.properties.target);
  return { resources: [{
    id: context.resourceId(), provider: 'simulator', spec: { ...base, ...(target ? { target } : {}) },
  }] };
}

const adapter: CapabilityAdapter = {
  id: 'local-simulation', mode: 'simulation', supports: simulationSupport, lower,
};

/** Explicit simulation only. This selects no vendor product and contacts no provider. */
export function simulationProfile(options: { id?: string; targetId?: string; artifacts: Record<string, JsonObject> }): BindingProfile {
  const values = slots(options, ['id', 'targetId', 'artifacts'], 'simulation profile options');
  return readProfile({
    id: values.id === undefined ? 'local-simulation' : values.id as string,
    target: { id: values.targetId === undefined ? 'local-simulator' : values.targetId as string, properties: { mode: 'simulation' } },
    rules: [
      { id: 'compute-simulation', family: 'compute', adapterId: adapter.id },
      { id: 'storage-simulation', family: 'storage', adapterId: adapter.id },
      { id: 'network-simulation', family: 'network', adapterId: adapter.id },
    ],
    adapters: [adapter],
    artifacts: values.artifacts as Record<string, JsonObject>,
  });
}

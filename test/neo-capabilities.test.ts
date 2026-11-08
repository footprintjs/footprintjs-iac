import assert from 'node:assert/strict';
import test from 'node:test';
import { artifact, ref, system } from '../src/system/index.ts';
import { bindSystem } from '../src/binding/index.ts';
import type { BindingProfile } from '../src/binding/types.ts';
import type { JsonObject, Resource } from '../src/types.ts';
import { createNeoSystem } from '../integration/neo/system.ts';
import { neoKubernetesProfile } from '../integration/neo/kubernetes-profile.ts';
import { createNeoStack, NEO_NAMESPACE } from '../integration/neo/stack.ts';

const profile = () => neoKubernetesProfile({ context: 'kind-neo-capability-test' });
function manifest(resources: readonly Resource[], kind: string): Resource {
  const matches = resources.filter(resource => resource.spec.kind === kind);
  assert.equal(matches.length, 1, 'exactly one ' + kind);
  return matches[0]!;
}
function customCompute(options: { replicas?: number; program?: string; identity?: boolean; path?: string } = {}) {
  const builder = system(NEO_NAMESPACE);
  if (options.identity) builder.principal('neo-actor', { description: 'not supported by this fixture' });
  return builder.addCompute(options.path ?? 'application', compute => compute.addService('neo-app', service => {
    service.program(artifact(options.program ?? 'neo-program')).replicas(options.replicas ?? 1);
    if (options.identity) service.runAs(ref.principal('neo-actor'));
    return service;
  })).build();
}

test('Neo high-level system uses only the fixed service and HTTP endpoint capabilities', () => {
  const design = createNeoSystem();
  assert.equal(design.name, NEO_NAMESPACE);
  assert.deepEqual(design.capabilities.map(capability => [capability.id, capability.path, capability.family, capability.kind]), [
    ['neo-app', 'application.neo-app', 'compute', 'service'],
    ['neo-http', 'network.neo-http', 'network', 'endpoint'],
  ]);
  assert.deepEqual(design.capabilities[0]!.properties, { program: { kind: 'artifact', id: 'neo-program' }, replicas: 1 });
  assert.equal(design.capabilities.some(capability => capability.kind === 'segment'), false, 'Namespace is internal compute infrastructure, not an isolation claim');
  assert.deepEqual(design.principals, []);
});

test('real consumer binding preserves every legacy physical manifest and fixed Namespace→Deployment→Service dependencies', () => {
  const binding = bindSystem(createNeoSystem(), profile());
  const legacy = createNeoStack();
  assert.equal(binding.graph.resources.length, legacy.resources.length);
  for (const expected of legacy.resources) {
    const resource = manifest(binding.graph.resources, String(expected.spec.kind));
    assert.deepEqual(resource.spec, expected.spec);
    assert.equal(resource.provider, 'kubernetes');
    assert.notEqual(resource.id, expected.id, 'library identities are allocated by the binding target');
  }
  const namespace = manifest(binding.graph.resources, 'Namespace');
  const deployment = manifest(binding.graph.resources, 'Deployment');
  const service = manifest(binding.graph.resources, 'Service');
  assert.deepEqual(namespace.dependsOn ?? [], []);
  assert.deepEqual(deployment.dependsOn, [namespace.id]);
  assert.deepEqual(service.dependsOn, [deployment.id]);
  assert.deepEqual(binding.graph.relations.filter(relation => relation.kind === 'communicatesWith'), [{
    from: service.id, to: deployment.id, kind: 'communicatesWith', label: 'routes to service',
  }], 'architecture routes to the runtime Deployment rather than its Namespace prerequisite');
  const compute = binding.mappings.find(mapping => mapping.capabilityId === 'neo-app')!;
  assert.deepEqual(compute.entryPoints, [namespace.id]);
  assert.deepEqual(compute.exitPoints, [deployment.id]);
  const endpoint = binding.mappings.find(mapping => mapping.capabilityId === 'neo-http')!;
  assert.deepEqual(endpoint.resourceIds, [service.id]);
});

test('both adapter decisions assess every declared property as implemented without claiming runtime verification', () => {
  const design = createNeoSystem();
  const binding = bindSystem(design, profile());
  assert.equal(binding.decisions.length, 2);
  for (const decision of binding.decisions) {
    const capability = design.capabilities.find(capability => capability.id === decision.capabilityId)!;
    assert.equal(decision.mode, 'real');
    assert.equal(decision.status, 'implemented');
    assert.deepEqual(decision.requirements.map(row => row.property).sort(), Object.keys(capability.properties).sort());
    for (const support of decision.requirements) {
      assert.equal(support.status, 'implemented');
      assert.deepEqual(support.requested, capability.properties[support.property]);
      assert.notEqual(support.status as string, 'verified');
    }
  }
  const origins = binding.graph.boundaries.filter(boundary => boundary.attributes?.origin === 'capability');
  assert.equal(origins.length, 2);
  for (const origin of origins) {
    assert.equal(origin.attributes!.designDigest, design.digest);
    assert.equal(origin.attributes!.mode, 'real');
    assert.equal(origin.attributes!.decisionStatus, 'declared');
    assert.match(String(origin.attributes!.support), /not observed verification/);
  }
});

test('replicas two changes only desired Deployment replica count while physical and allocated identities stay stable', () => {
  const one = bindSystem(createNeoSystem(), profile());
  const two = bindSystem(createNeoSystem({ replicas: 2 }), profile());
  assert.deepEqual(two.graph.resources.map(resource => resource.id), one.graph.resources.map(resource => resource.id));
  const expected = structuredClone(manifest(one.graph.resources, 'Deployment').spec);
  (expected.spec as JsonObject).replicas = 2;
  assert.deepEqual(manifest(two.graph.resources, 'Deployment').spec, expected);
  assert.deepEqual(manifest(two.graph.resources, 'Namespace').spec, manifest(one.graph.resources, 'Namespace').spec);
  assert.deepEqual(manifest(two.graph.resources, 'Service').spec, manifest(one.graph.resources, 'Service').spec);
  for (const replicas of [0, -1, 3, 1.5]) assert.throws(() => createNeoSystem({ replicas }), /one or two/);
});

test('cached image choices affect only the exact container image fields and preserve security/env/probes', () => {
  const selected = { nodeImage: 'fixture/neo-node:reviewed', pythonImage: 'fixture/neo-python:reviewed' };
  const binding = bindSystem(createNeoSystem(), neoKubernetesProfile({ context: 'kind-neo-capability-test', ...selected }));
  for (const expected of createNeoStack(selected).resources) {
    assert.deepEqual(manifest(binding.graph.resources, String(expected.spec.kind)).spec, expected.spec);
  }
  assert.deepEqual(binding.graph.resources.map(resource => resource.id), bindSystem(createNeoSystem(), profile()).graph.resources.map(resource => resource.id));
  const deployment = manifest(binding.graph.resources, 'Deployment').spec.spec as JsonObject;
  const template = deployment.template as JsonObject;
  const pod = template.spec as JsonObject;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal((pod.securityContext as JsonObject).runAsNonRoot, true);
  const containers = pod.containers as JsonObject[];
  assert.deepEqual(containers.map(container => container.imagePullPolicy), ['Never', 'Never']);
  assert.deepEqual(containers.map(container => container.name), ['node', 'python']);
});

test('explicit target context/namespace determine library identity; a context switch cannot silently reuse addresses', () => {
  const a = bindSystem(createNeoSystem(), neoKubernetesProfile({ context: 'kind-a' }));
  const again = bindSystem(createNeoSystem(), neoKubernetesProfile({ context: 'kind-a' }));
  const b = bindSystem(createNeoSystem(), neoKubernetesProfile({ context: 'kind-b' }));
  assert.deepEqual(a, again);
  assert.notEqual(a.targetId, b.targetId);
  assert.notDeepEqual(a.graph.resources.map(resource => resource.id), b.graph.resources.map(resource => resource.id));
  assert.equal(a.target.properties!.context, 'kind-a');
  assert.equal(a.target.properties!.namespace, NEO_NAMESPACE);
  assert.equal(manifest(a.graph.resources, 'Namespace').spec.metadata && (manifest(a.graph.resources, 'Namespace').spec.metadata as JsonObject).name, NEO_NAMESPACE);
});

test('fixture adapters reject unsupported compute paths, arbitrary programs, replicas, identity and storage', () => {
  assert.throws(() => bindSystem(customCompute({ replicas: 3 }), profile()), /Unsupported capability/);
  assert.throws(() => bindSystem(customCompute({ program: 'arbitrary-program' }), profile()), /Unsupported capability/);
  assert.throws(() => bindSystem(customCompute({ identity: true }), profile()), /Unsupported capability/);
  assert.throws(() => bindSystem(customCompute({ path: 'unrelated' }), profile()), /Unsupported capability/);
  const storage = system(NEO_NAMESPACE).addStorage('data', s => s.addStore('records', x => x.dataModel('relational'))).build();
  assert.throws(() => bindSystem(storage, profile()), /No binding rule/);
  const segment = system(NEO_NAMESPACE).addNetwork('network', n => n.addSegment('backend')).build();
  assert.throws(() => bindSystem(segment, profile()), /No binding rule/);
});

test('HTTP endpoint supports exactly the Neo target, HTTP protocol and port 5230', () => {
  for (const choice of [{ protocol: 'https' as const, port: 5230 }, { protocol: 'http' as const, port: 80 }]) {
    const design = system(NEO_NAMESPACE).addCompute('application', c => c.addService('neo-app', s => s.program(artifact('neo-program')).replicas(1)))
      .addNetwork('network', n => n.addEndpoint('neo-http', e => e.protocol(choice.protocol).port(choice.port).target(ref.service('application.neo-app')))).build();
    assert.throws(() => bindSystem(design, profile()), /Unsupported capability/);
  }
});

test('real fixture profile refuses required isolation rather than treating a Namespace as a network boundary', () => {
  const design = system(NEO_NAMESPACE).addCompute('application', c => c.addService('neo-app', s => s.program(artifact('neo-program')).replicas(1)))
    .boundary({ id: 'isolated', kind: 'security', requirements: [{ kind: 'network-isolation', mode: 'required' }] })
    .within('isolated', ref.service('application.neo-app')).build();
  assert.throws(() => bindSystem(design, profile()), /required boundary/);
});

test('artifact options are strict detached JSON and cannot merge credentials or arbitrary environment into manifests', () => {
  let getterCalls = 0;
  const bad = Object.defineProperty({ context: 'kind-test' }, 'nodeImage', { enumerable: true, get() { getterCalls++; return 'image:local'; } });
  assert.throws(() => neoKubernetesProfile(bad), /accessors/);
  assert.equal(getterCalls, 0);
  assert.throws(() => neoKubernetesProfile({ context: '' }), /explicit/);
  assert.throws(() => neoKubernetesProfile({ context: '-danger' }), /explicit/);
  assert.throws(() => neoKubernetesProfile({ context: 'kind-test', nodeImage: 'user:password@registry/image' }), /credentials/);
  assert.throws(() => neoKubernetesProfile({ context: 'kind-test', token: 'secret' } as never), /Unknown Neo Kubernetes/);
  const original = profile();
  const injected: BindingProfile = { ...original, artifacts: {
    'neo-program': { ...original.artifacts['neo-program']!, env: { MODEL_KEY: 'must-never-be-merged' } },
  } };
  assert.throws(() => bindSystem(createNeoSystem(), injected), /Unsupported capability/);
});

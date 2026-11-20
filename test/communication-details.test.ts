import assert from 'node:assert/strict';
import test from 'node:test';
import { artifact, bindSystem, infra, ref, simulationProfile, system, validateInfraGraph } from '../src/index.ts';
import { defineSystemTopology, validateSystemTopologyDefinition } from '../src/system-topology/node.ts';
import type { CommunicationDetails, RelationKind } from '../src/graph/index.ts';

const details = { operation: 'GetObject', protocol: { application: 'HTTPS', transport: 'TCP', port: 443 },
  route: { network: 'IPv4', via: ['Gateway endpoint', 'Regional service'] } };
function graph(metadata?: CommunicationDetails, kind: RelationKind = 'communicatesWith') {
  return infra('test').resource('worker', 'fixture', {}).resource('bucket', 'fixture', {}).resource('queue', 'fixture', {})
    .connect('worker', 'bucket', kind, 'Read report', metadata).connect('queue', 'worker', 'order').build();
}

test('connection details survive binding an inferred store use and retain the same endpoints', () => {
  const storage = ref.store('data.reports'), compute = ref.service('work.api');
  const app = system('reports').addStorage('data', s => s.addStore('reports', b => b.dataModel('object')))
    .addCompute('work', c => c.addService('api', b => b.program(artifact('api')).useStorage(storage, { access: 'read' })));
  app.connect(compute, storage, 'communicatesWith', 'Read report', details);
  const design = app.build();
  assert.equal(design.relations.filter(r => r.kind === 'communicatesWith').length, 1);
  const bound = bindSystem(design, simulationProfile({ artifacts: { api: { image: 'fixture' } } }));
  const edge = bound.graph.relations.find(r => r.kind === 'communicatesWith');
  assert.deepEqual(edge?.details, details);
  assert.equal(edge?.label, 'Read report');
});

test('metadata commits to the graph while preserving edge indices and resource dependencies', () => {
  const old = graph(), next = graph(details);
  assert.deepEqual(validateInfraGraph(JSON.parse(JSON.stringify(old))), old);
  assert.deepEqual(next.relations.map(({ details: _d, ...r }) => r), old.relations);
  assert.deepEqual(old.resources, next.resources);
  assert.notEqual(old.digest, next.digest);
  const tampered = structuredClone(next);
  tampered.relations.find(r => r.details)!.details!.operation = 'ListObjects';
  assert.throws(() => validateInfraGraph(tampered), /digest/);
  for (const invalid of [{ protocol: { port: 0 } }, { route: { via: ['https://private.example'] } },
    { protocol: { status: 'passed' } }, { route: { via: [] } }, {}]) {
    assert.throws(() => graph(invalid as CommunicationDetails));
  }
  assert.throws(() => graph(details, 'order'), /communicatesWith/);
});

test('topology admission accepts partial metadata and binds it to its declaration digest', () => {
  const binding = { targetId: 'lab', graphDigest: graph().digest };
  const input = { id: 'example', label: 'Example', boundaries: [],
    nodes: ['worker','bucket'].map(id => ({ id, label: id, category: 'other' as const, origin: 'existing' as const, bindings: { resourceIds: [id] } })),
    connections: [{ id: 'read', from: 'worker', to: 'bucket', kind: 'communicatesWith' as const, details: { operation: 'GetObject' } }] };
  const declaration = defineSystemTopology(input, binding);
  assert.deepEqual(validateSystemTopologyDefinition(declaration), declaration);
  assert.throws(() => defineSystemTopology({ ...input, connections: [{ ...input.connections[0]!, kind: 'dependsOn' }] }, binding));
});

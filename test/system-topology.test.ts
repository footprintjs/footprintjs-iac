import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSystemTopology, validateSystemTopologyDefinition, validateSystemTopologyView } from '../src/system-topology/node.ts';
import { projectSystemTopology, readSystemTopologyView } from '../src/system-topology/index.ts';
const hash = 'a'.repeat(64), configuration = 'b'.repeat(64);
function definition() {
    return defineSystemTopology({ id: 'application', label: 'Application', boundaries: [{ id: 'server', label: 'Registered Linux server', kind: 'host', bindings: { resourceIds: [], checkIds: ['host-identity'] } }], nodes: [{ id: 'api', label: 'Application API', category: 'compute', origin: 'existing', boundaryId: 'server', technology: { id: 'nodedotjs', label: 'Node.js' }, bindings: { resourceIds: ['services'], componentIds: ['api-unit'], checkIds: ['health'] } }, { id: 'tools', label: 'Tools', category: 'compute', origin: 'existing', boundaryId: 'server', bindings: { resourceIds: ['services'], componentIds: ['tools-unit'] } }, { id: 'data', label: 'Existing data', category: 'storage', origin: 'existing', bindings: { resourceIds: [], checkIds: ['data-readable'] } }], connections: [{ id: 'api-data', from: 'api', to: 'data', kind: 'communicatesWith', checkIds: ['data-readable'] }] }, { targetId: 'registered-host', graphDigest: hash });
}
const proof = (kind: 'adapter' | 'deployment' | 'check', complete = true) => ({ kind, runId: 'native-run', runtimeStageId: 'observe#1', complete });
function observations(d = definition()) {
    return { targetId: d.binding.targetId, graphDigest: hash, definitionDigest: d.digest, configurationDigest: configuration, resources: [], components: [], checks: [] } as import('../src/system-topology/types.ts').SystemTopologyObservations;
}
test('declaration and initial projection do no provider work and show every logical component pending', () => {
    const d = definition(), v = projectSystemTopology(d, observations(d));
    assert.equal(v.nodes.length, 3);
    assert(v.nodes.every(n => n.status === 'pending'));
    assert.equal(v.connections[0]!.status, 'untested');
    assert.equal(v.boundaries[0]!.observed, false);
    assert.equal(v.nodes[0]!.facts.running, 'unknown');
    assert.deepEqual(validateSystemTopologyView(JSON.parse(JSON.stringify(v))), v);
});
test('a ready atomic service group cannot claim independently measured unit readiness', () => {
    const d = definition(), o = observations(d);
    o.resources = [{ id: 'services', status: 'ready', action: 'update', evidence: proof('deployment') }];
    const v = projectSystemTopology(d, o);
    assert.equal(v.nodes[0]!.status, 'unknown');
    assert.equal(v.nodes[0]!.evidenceScope, 'shared-resource');
    assert.equal(v.nodes[0]!.facts.running, 'unknown');
    assert(v.nodes[0]!.limitations.length);
    assert.equal(v.connections[0]!.status, 'untested');
});
test('actual unit observation and its required check establish readiness without borrowing sibling results', () => {
    const d = definition(), o = observations(d);
    o.components = [{ id: 'api-unit', resourceId: 'services', phase: 'observe', status: 'passed', installed: true, running: true, evidence: proof('adapter') }];
    o.checks = [{ id: 'health', status: 'passed', evidence: proof('check') }];
    const v = projectSystemTopology(d, o);
    assert.equal(v.nodes[0]!.status, 'ready');
    assert.equal(v.nodes[0]!.facts.running, 'confirmed');
    assert.equal(v.nodes[1]!.status, 'pending');
    assert.equal(v.boundaries[0]!.observed, false);
});
test('an explicit failed connection remains failed even when its runtime resource is ready', () => {
    const d = definition(), o = observations(d);
    o.resources = [{ id: 'services', status: 'ready', action: 'update', evidence: proof('deployment') }];
    o.checks = [{ id: 'data-readable', status: 'failed', evidence: proof('check') }];
    const v = projectSystemTopology(d, o);
    assert.equal(v.connections[0]!.status, 'failed');
    assert.equal(v.nodes[2]!.status, 'failed');
});
test('existing data becomes connected only from its own admitted check; suite activity alone supplies no checking', () => {
    const d = definition(), o = observations(d);
    o.checks = [{ id: 'health', status: 'checking', evidence: proof('check', false) }];
    assert.equal(projectSystemTopology(d, o).connections[0]!.status, 'untested');
    o.checks = [{ id: 'data-readable', status: 'passed', evidence: proof('check') }];
    const v = projectSystemTopology(d, o);
    assert.equal(v.connections[0]!.status, 'connected');
    assert.equal(v.nodes[2]!.status, 'connected');
    assert.equal(v.nodes[2]!.facts.installed, 'unknown');
    assert.equal(v.nodes[2]!.originLabel, 'Existing');
});
test('lost or unadmitted passing capture cannot turn a component or connection green', () => {
    const d = definition(), o = observations(d);
    o.components = [{ id: 'api-unit', resourceId: 'services', phase: 'observe', status: 'passed', installed: true, running: true, evidence: proof('adapter', false) }];
    o.checks = [{ id: 'data-readable', status: 'passed', evidence: proof('check', false) }];
    const v = projectSystemTopology(d, o);
    assert.equal(v.nodes[0]!.status, 'incomplete');
    assert.equal(v.connections[0]!.status, 'incomplete');
});
test('foreign target, graph, declaration and edited projected statuses are refused', () => {
    const d = definition(), o = observations(d);
    for (const key of ['targetId', 'graphDigest', 'definitionDigest'])
        assert.throws(() => projectSystemTopology(d, { ...o, [key]: key === 'targetId' ? 'foreign' : 'c'.repeat(64) }));
    const v = projectSystemTopology(d, o);
    assert.throws(() => readSystemTopologyView({ ...v, nodes: v.nodes.map((n, i) => i ? n : { ...n, status: 'ready' }) }));
    assert.throws(() => validateSystemTopologyDefinition({ ...d, label: 'Changed' }));
});
test('declarations reject cyclic boundaries, unknown edges, executable fields and ambiguous bindings', () => {
    const d = definition();
    assert.throws(() => defineSystemTopology({ ...d, boundaries: [{ id: 'one', label: 'one', kind: 'host', parentId: 'two' }, { id: 'two', label: 'two', kind: 'runtime', parentId: 'one' }] } as any, d.binding));
    assert.throws(() => defineSystemTopology({ id: 'x', label: 'x', boundaries: [], nodes: [], connections: [{ id: 'bad', from: 'missing', to: 'missing', kind: 'communicatesWith' }] }, d.binding));
    assert.throws(() => validateSystemTopologyDefinition({ ...d, command: 'arbitrary' }));
    assert.throws(() => projectSystemTopology(d, { ...observations(d), checks: [{ id: 'health', status: 'passed', evidence: proof('check') }, { id: 'health', status: 'failed', evidence: proof('check') }] }));
});
test('component readiness never overrides an unknown required check', () => {
    const d = definition(), o = observations(d);
    o.components = [{ id: 'api-unit', resourceId: 'services', phase: 'observe', status: 'passed', installed: true, running: true, evidence: proof('adapter') }];
    o.checks = [{ id: 'health', status: 'unknown', evidence: proof('check') }];
    const v = projectSystemTopology(d, o);
    assert.equal(v.nodes[0]!.status, 'unknown');
    assert.equal(v.nodes[0]!.facts.connected, 'unknown');
});
test('missing required resources cannot be hidden by one ready resource', () => {
    const base = definition();
    const d = defineSystemTopology({ id: base.id, label: base.label, boundaries: base.boundaries, nodes: [{ id: 'combined', label: 'Combined runtime', category: 'compute', origin: 'deployment', bindings: { resourceIds: ['one', 'two'] } }], connections: [] }, base.binding);
    const o = observations(d);
    o.resources = [{ id: 'one', status: 'ready', evidence: proof('deployment') }];
    assert.equal(projectSystemTopology(d, o).nodes[0]!.status, 'unknown');
});
test('boundary verification requires every declared check and component; configuration alone is not component completion', () => {
    const base = definition();
    const d = defineSystemTopology({ id: base.id, label: base.label, boundaries: [{ ...base.boundaries[0]!, bindings: { resourceIds: ['services'], componentIds: ['api-unit'], checkIds: ['host-identity'] } }], nodes: base.nodes, connections: base.connections }, base.binding);
    const o = observations(d);
    o.checks = [{ id: 'host-identity', status: 'passed', evidence: proof('check') }];
    o.components = [{ id: 'api-unit', resourceId: 'services', phase: 'configure', status: 'passed', evidence: proof('adapter') }];
    const v = projectSystemTopology(d, o);
    assert.equal(v.boundaries[0]!.observed, false);
    assert.equal(v.nodes[0]!.progress.completed, 0);
});
test('component and boundary identities cannot collide in a topology', () => {
 const d = definition();
 assert.throws(() => defineSystemTopology({id:d.id,label:d.label,boundaries:d.boundaries,nodes:[{...d.nodes[0]!,id:'server'}],connections:[]}, d.binding));
});
test('duplicate component IDs on different resources cannot substitute a missing required component', () => {
 const base=definition();const d=defineSystemTopology({id:base.id,label:base.label,boundaries:[],nodes:[{id:'runtime',label:'Runtime',category:'compute',origin:'deployment',bindings:{resourceIds:['one','two'],componentIds:['api','tools']}}],connections:[]},base.binding);
 const o=observations(d);o.components=['one','two'].map(resourceId=>({id:'api',resourceId,phase:'observe',status:'passed',installed:true,running:true,evidence:proof('adapter')}));
 const node=projectSystemTopology(d,o).nodes[0]!;assert.equal(node.status,'unknown');assert.equal(node.progress.completed,0);assert.equal(node.facts.installed,'unknown');assert.equal(node.facts.running,'unknown');
});
test('a pre-effect observation cannot establish current facts after an uncertain mutation', () => {
 const d=definition(),o=observations(d);o.resources=[{id:'services',status:'failed',action:'update',evidence:proof('deployment')}];o.components=[{id:'api-unit',resourceId:'services',phase:'revalidate',status:'passed',installed:true,running:true,evidence:proof('adapter')}];
 const node=projectSystemTopology(d,o).nodes[0]!;assert.equal(node.status,'failed');assert.equal(node.facts.running,'unknown');assert.equal(node.facts.installed,'unknown');
});

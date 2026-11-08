import assert from 'node:assert/strict';
import test from 'node:test';
import { InfraEngine } from '../src/engine.ts';
import { buildPlan } from '../src/planner.ts';
import type { JsonObject, ResourceAdapter, Stack, StateStore } from '../src/types.ts';
import {
  assertExecutableGraph, compileGraph, infra, parallelGroup, readInfraGraph, resource,
  serialGroup, toStack, validateInfraGraph,
} from '../src/graph/index.ts';

const node = (id: string, dependsOn?: string[]) => resource(id, 'simulator', { label: id }, dependsOn);
const copied = (value: unknown) => JSON.parse(JSON.stringify(value));

test('serial and parallel groups synthesize the same canonical fork/join graph as fluent chaining', () => {
  const [network, db, cache, api] = ['network', 'db', 'cache', 'api'].map(id => node(id));
  const graph = infra('app').start(network!).parallel(db!, cache!).next(api!).synth();
  const nested = infra('app').serial(network!, parallelGroup(cache!, db!), api!).synth();
  assert.deepEqual(graph, nested);
  assert.deepEqual(graph.resources.map(row => [row.id, row.dependsOn ?? []]), [
    ['api', ['cache', 'db']], ['cache', ['network']], ['db', ['network']], ['network', []],
  ]);
  assert.deepEqual(graph.relations.map(row => [row.from, row.to]).sort(), [
    ['cache', 'api'], ['db', 'api'], ['network', 'cache'], ['network', 'db'],
  ].sort());
});

test('nested serial branches join their exits, not every intermediate stage', () => {
  const graph = infra('nested').serial(node('root'),
    parallelGroup(serialGroup(node('a'), node('b')), node('c')), node('end')).synth();
  assert.deepEqual(graph.resources.find(row => row.id === 'end')!.dependsOn, ['b', 'c']);
  assert.deepEqual(graph.resources.find(row => row.id === 'b')!.dependsOn, ['a']);
  assert.deepEqual(graph.resources.find(row => row.id === 'a')!.dependsOn, ['root']);
});

test('start opens an independent chain and preregistered string references work', () => {
  const graph = infra('independent').resource('a', 'simulator', {}).resource(node('b'))
    .resource(node('c')).start('a').next('b').start('c').synth();
  assert.deepEqual(graph.resources.find(row => row.id === 'b')!.dependsOn, ['a']);
  assert.equal(graph.resources.find(row => row.id === 'c')!.dependsOn, undefined);
});

test('resource dependencies and explicit data edges are represented in the shared IR', () => {
  const graph = infra('deps').resource(node('source')).resource(node('sink', ['source']))
    .connect('source', 'sink', 'data', 'Declared input dependency; no provider output interpolation')
    .synth();
  assert.deepEqual(graph.resources.find(row => row.id === 'sink')!.dependsOn, ['source']);
  assert.deepEqual(graph.relations, [{
    from: 'source', to: 'sink', kind: 'data',
    label: 'Declared input dependency; no provider output interpolation',
  }]);
});

test('resource handles and synthesized artifacts detach caller data and deeply freeze it', () => {
  const spec = { nested: { replicas: 1 }, values: [1, 2] };
  const handle = resource('app', 'simulator', spec);
  spec.nested.replicas = 99;
  const builder = infra('frozen').start(handle);
  const graph = builder.synth();
  builder.resource(node('later'));
  assert.equal((graph.resources[0]!.spec.nested as JsonObject).replicas, 1);
  assert.equal(graph.resources.length, 1);
  assert.ok(Object.isFrozen(handle.spec));
  assert.ok(Object.isFrozen(graph));
  assert.ok(Object.isFrozen(graph.resources[0]!.spec.nested));
  assert.throws(() => { (graph.resources[0]!.spec.nested as JsonObject).replicas = 2; }, TypeError);
});

test('JSON round trips are revalidated, detached, frozen, and compatible with Stack without dropping the envelope', () => {
  const original = infra('roundtrip').start(node('a')).synth();
  const plain = copied(original);
  const read = readInfraGraph(plain);
  assert.deepEqual(read, original);
  plain.resources[0].spec.label = 'tampered later';
  assert.equal(read.resources[0]!.spec.label, 'a');
  assert.ok(Object.isFrozen(read.resources));
  assert.deepEqual(toStack(read), read);
  assert.equal((toStack(read) as { kind?: string }).kind, 'infra-graph');
});

test('digest includes graph topology, specifications and boundary metadata, and rejects modification', () => {
  const base = infra('signed').start(node('a')).synth();
  const moved = infra('signed').start(node('a')).boundary({ id: 'room', kind: 'physical', attributes: { room: 'A' } }).within('room', 'a').synth();
  assert.notEqual(moved.digest, base.digest);
  assert.deepEqual(moved.resources, base.resources);
  const tampered = copied(base);
  tampered.resources[0].spec.label = 'b';
  assert.throws(() => validateInfraGraph(tampered), /digest mismatch/);
  const missing = copied(base); delete missing.digest;
  assert.throws(() => validateInfraGraph(missing), /digest/);
});

test('overlapping boundary facets and same-facet nesting preserve resource identity', () => {
  const graph = infra('facets').start(node('app'))
    .boundary({ id: 'all', kind: 'group' })
    .boundary({ id: 'west', kind: 'region', parent: 'all' })
    .boundary({ id: 'west-zone', kind: 'region', parent: 'west' })
    .boundary({ id: 'private', kind: 'security' })
    .boundary({ id: 'room-a', kind: 'physical' })
    .boundary({ id: 'database', kind: 'role' })
    .within('west-zone', 'app').within('private', 'app').within('room-a', 'app').within('database', 'app').synth();
  assert.equal(graph.memberships.length, 4);
  assert.equal(graph.resources[0]!.id, 'app');
  assert.equal(graph.resources[0]!.dependsOn, undefined);
  assertExecutableGraph(graph);
});

test('architecture relations may cycle and do not become deployment dependencies', () => {
  const graph = infra('connections').start(node('a')).start(node('b'))
    .connect('a', 'b', 'communicatesWith').connect('b', 'a', 'communicatesWith')
    .connect('a', 'b', 'runsOn').connect('b', 'a', 'assumesRole').synth();
  assert.ok(graph.resources.every(row => row.dependsOn === undefined));
  assert.equal(graph.relations.length, 4);
});

test('dependency cycles, self dependencies, unknown dependencies, and unknown relation endpoints fail synthesis', () => {
  assert.throws(() => infra('cycle').serial(node('a'), node('b')).dependsOn('a', 'b').synth(), /cycle/);
  assert.throws(() => infra('self').start(node('a')).dependsOn('a', 'a').synth(), /cycle/);
  assert.throws(() => infra('unknown').start(node('a', ['missing'])).synth(), /Unknown relation endpoint/);
  assert.throws(() => infra('unknown').start(node('a')).connect('a', 'missing', 'runsOn').synth(), /Unknown relation endpoint/);
});

test('duplicate declarations and conflicting handles are rejected', () => {
  assert.throws(() => infra('duplicate').resource(node('a')).resource(node('a')), /Duplicate resource/);
  assert.throws(() => infra('conflict').start(node('a')).next(resource('a', 'simulator', { other: true })), /Conflicting resource/);
  assert.throws(() => resource('a', 'simulator', {}, ['b', 'b']), /Duplicate dependency/);
  assert.throws(() => infra('duplicate').resource(node('a')).resource(node('b'))
    .connect('a', 'b', 'order').connect('a', 'b', 'order'), /Duplicate relation/);
});

test('boundary unknown parents, parent cycles, incompatible parent kinds and unknown memberships fail', () => {
  assert.throws(() => infra('x').boundary({ id: 'a', kind: 'physical', parent: 'missing' }).synth(), /Unknown boundary parent/);
  assert.throws(() => infra('x').boundary({ id: 'a', kind: 'group', parent: 'b' })
    .boundary({ id: 'b', kind: 'group', parent: 'a' }).synth(), /cycle/);
  assert.throws(() => infra('x').boundary({ id: 'a', kind: 'region' })
    .boundary({ id: 'b', kind: 'physical', parent: 'a' }).synth(), /Incompatible boundary parent/);
  assert.throws(() => infra('x').start(node('a')).within('missing', 'a').synth(), /Unknown membership boundary/);
  assert.throws(() => infra('x').boundary({ id: 'zone', kind: 'security' }).within('zone', 'missing').synth(), /Unknown membership resource/);
  assert.throws(() => infra('x').start(node('a')).boundary({ id: 'z', kind: 'group' }).within('z', 'a').within('z', 'a'), /Duplicate boundary membership/);
});

test('invalid IDs, kinds and unsupported symbolic outputs are not admitted as JSON definitions', () => {
  for (const id of ['', '../bad', '__proto__', 'constructor', 'has space']) assert.throws(() => resource(id, 'simulator', {}), /identifier/);
  assert.throws(() => infra('bad/name'), /identifier/);
  assert.throws(() => infra('x').boundary({ id: 'a', kind: 'iam' as never }), /boundary kind/);
  assert.throws(() => resource('a', 'simulator', { value: () => 'output' } as unknown as JsonObject), /JSON/);
});

test('plain JSON validation rejects non-finite values, undefined, sparse arrays, accessors and hidden objects without executing them', () => {
  let invoked = false;
  const cycle: JsonObject = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get: () => { invoked = true; return 'bad'; } });
  const numericExpando = Object.assign([], { 4294967295: 'extra' });
  for (const spec of [
    { n: Number.NaN }, { n: undefined }, { date: new Date() }, { list: new Array(2) }, getter,
    { list: numericExpando }, Object.create({ inherited: true }), cycle,
  ]) assert.throws(() => resource('a', 'simulator', spec as JsonObject), /JSON|accessors|arrays|plain/);
  assert.equal(invoked, false);
});

test('JSON prototype-looking keys stay own data without mutating a prototype', () => {
  const spec = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}');
  const graph = infra('own-data').start(resource('a', 'simulator', spec)).synth();
  assert.equal(Object.hasOwn(graph.resources[0]!.spec, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(graph.resources[0]!.spec), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.deepEqual(validateInfraGraph(copied(graph)), graph);
});

test('runtime validation rejects duplicate IDs/edges, unrepresented deps, unknown fields and unknown graph versions', () => {
  const original = infra('runtime').serial(node('a'), node('b')).synth();
  const duplicate = copied(original); duplicate.resources.push(duplicate.resources[0]);
  assert.throws(() => validateInfraGraph(duplicate), /Duplicate resource/);
  const edges = copied(original); edges.relations.push(edges.relations[0]);
  assert.throws(() => validateInfraGraph(edges), /Duplicate relation/);
  const deps = copied(original); deps.resources.find((row: { id: string }) => row.id === 'b').dependsOn = [];
  assert.throws(() => validateInfraGraph(deps), /disagree/);
  const extra = copied(original); extra.policy = 'trusted';
  assert.throws(() => validateInfraGraph(extra), /Unknown infra graph field/);
  const version = copied(original); version.version = 2;
  assert.throws(() => validateInfraGraph(version), /kind\/version/);
});

test('advisory boundaries remain descriptive; all required enforcement is rejected explicitly', () => {
  const advisory = infra('advisory').start(node('a')).boundary({
    id: 'security', kind: 'security',
    requirements: [{ kind: 'encrypted', mode: 'advisory', value: true }],
  }).within('security', 'a').synth();
  assertExecutableGraph(advisory);
  const required = infra('required').start(node('a')).boundary({
    id: 'security', kind: 'security',
    requirements: [{ kind: 'encrypted', mode: 'required', value: true }],
  }).within('security', 'a').synth();
  assert.ok(required.digest);
  assert.throws(() => assertExecutableGraph(required), /Unsupported required boundary enforcement/);
  assert.throws(() => assertExecutableGraph(toStack(required)), /Unsupported required/);
});

test('malformed identifiable graph envelopes never fall back to plain Stack handling', () => {
  const original = infra('envelope').start(node('a')).synth();
  for (const patch of [
    { kind: 'stack' }, { version: 99 }, { kind: undefined }, { digest: 'fake' }, { boundaries: null },
  ]) assert.throws(() => assertExecutableGraph({ ...copied(original), ...patch }));
  assert.doesNotThrow(() => assertExecutableGraph({ name: 'plain', resources: [] }));
});

test('graph safety gate rejects required or tampered graphs before plan/apply can read state or observe a provider', async () => {
  let reads = 0; let observations = 0;
  const store: StateStore = {
    async load() { reads++; throw new Error('must not load'); },
    async save() { throw new Error('must not save'); },
    async append() { throw new Error('must not append'); },
    async withLock(_stack, work) { reads++; return work(); },
    async saveEvidence() { throw new Error('must not save evidence'); },
  };
  const adapter: ResourceAdapter = {
    name: 'simulator',
    async observe() { observations++; return { exists: false }; },
    async apply() { throw new Error('must not apply'); },
    async remove() { throw new Error('must not remove'); },
    async waitReady() { throw new Error('must not wait'); },
  };
  const graph = infra('required').start(node('a')).boundary({
    id: 'zone', kind: 'security', requirements: [{ kind: 'isolate', mode: 'required' }],
  }).synth();
  const engine = new InfraEngine({ adapters: [adapter], store });
  for (const stack of [graph, { ...copied(graph), kind: 'plain' } as Stack]) {
    await assert.rejects(() => buildPlan(stack, { version: 1, stack: 'required', resources: {} }, new Map([[adapter.name, adapter]])), /required|kind\/version/);
    await assert.rejects(() => engine.plan(stack), /required|kind\/version/);
    await assert.rejects(() => engine.apply(stack), /required|kind\/version/);
  }
  assert.equal(reads, 0);
  assert.equal(observations, 0);
});

test('standalone compiler rejects duplicate resources and validates the resulting IR', () => {
  assert.throws(() => compileGraph({
    name: 'duplicate', resources: [node('a'), node('a')], boundaries: [], memberships: [], relations: [],
  }), /Duplicate resource/);
  assert.throws(() => parallelGroup(), /at least one/);
  assert.throws(() => serialGroup(), /at least one/);
});


test('boundary nesting is bounded before recursive renderers can consume the artifact', () => {
  const builder = infra('deep-boundaries');
  for (let index = 0; index < 64; index++) builder.boundary({
    id: `group-${index}`, kind: 'group', ...(index === 0 ? {} : { parent: `group-${index - 1}` }),
  });
  const accepted = builder.synth();
  assert.equal(accepted.boundaries.length, 64);
  builder.boundary({ id: 'group-64', kind: 'group', parent: 'group-63' });
  assert.throws(() => builder.synth(), /maximum depth of 64/);
  const tooDeep = copied(accepted);
  tooDeep.boundaries.push({ id: 'group-64', kind: 'group', parent: 'group-63' });
  assert.throws(() => validateInfraGraph(tooDeep), /maximum depth of 64/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifact, ref, system, validateSystemDesign,
  type StoreBuilder, type StorageScope, type SystemBuilder, type SystemRecipe,
} from '../src/system/index.ts';
import type { JsonObject } from '../src/types.ts';

const copied = (value: unknown) => JSON.parse(JSON.stringify(value));
function neo() {
  return system('neo')
    .addNetwork('network', n => n.addSegment('backend'))
    .addStorage('state', s => s
      .addSessionStore('sessions', x => x.sharing('shared').durability('persistent').expiration({ idle: '30m' }))
      .addDataStore('history', x => x.dataModel('relational').durability('persistent').retainOnRemoval()))
    .addCompute('application', c => c.addService('api', v => v
      .program(artifact('neo-api'))
      .useNetwork(ref.network('network.backend'))
      .useStorage(ref.store('state.sessions'), { access: 'readWrite' })))
    .build();
}

test('agreed high-level scoped API produces a pure typed capability design with visible defaults', () => {
  const design = neo();
  assert.equal(design.kind, 'system-design');
  assert.deepEqual(design.capabilities.map(row => [row.id, row.path, row.family, row.kind]), [
    ['api', 'application.api', 'compute', 'service'], ['backend', 'network.backend', 'network', 'segment'],
    ['history', 'state.history', 'storage', 'store'], ['sessions', 'state.sessions', 'storage', 'store'],
  ]);
  const sessions = design.capabilities.find(row => row.id === 'sessions')!;
  assert.deepEqual(sessions.properties, {
    purpose: 'session', dataModel: 'keyValue', sharing: 'shared',
    durability: 'persistent', expiration: { idle: '30m' },
  });
  assert.deepEqual(Object.keys(sessions.defaults).sort(), ['dataModel', 'purpose']);
  const history = design.capabilities.find(row => row.id === 'history')!;
  assert.deepEqual(history.properties.retention, { onRemoval: 'retain' });
  assert.equal(history.defaults.dataModel, undefined, 'explicit choice overrides the recipe default even when equal');
});

test('storage purpose/model/sharing/durability/expiry/replication/removal policy are independent facets', () => {
  const design = system('dimensions').addStorage('data', s => s.addSessionStore('sessions', x => x
    .dataModel('relational').sharing('local').durability('persistent')
    .expiration({ idle: '30m', absolute: '1d' }).replication({ copies: 3 })
    .retention({ period: '7d' }).retainOnRemoval(false))).build();
  const capability = design.capabilities[0]!;
  assert.equal(capability.properties.purpose, 'session');
  assert.equal(capability.properties.dataModel, 'relational');
  assert.equal(capability.properties.sharing, 'local');
  assert.deepEqual(capability.properties.replication, { copies: 3 });
  assert.deepEqual(capability.properties.retention, { period: '7d', onRemoval: 'delete' });
  assert.deepEqual(Object.keys(capability.defaults), ['purpose']);
});

test('generic stores have no silent durability/retention defaults; recipes only set their declared defaults', () => {
  const design = system('defaults').addStorage('data', s => s
    .addStore('generic', () => undefined)
    .addSessionStore('session', () => undefined)
    .addDataStore('records', () => undefined)).build();
  const generic = design.capabilities.find(row => row.id === 'generic')!;
  assert.deepEqual(generic.properties, {});
  assert.deepEqual(generic.defaults, {});
  for (const capability of design.capabilities) {
    assert.equal(capability.properties.durability, undefined);
    assert.equal(capability.properties.retention, undefined);
  }
  assert.equal(design.capabilities.find(row => row.id === 'records')!.properties.dataModel, 'relational');
});

test('consumer declaration order does not impose execution order; typed uses infer the necessary edges', () => {
  const graph = neo();
  assert.deepEqual(graph.relations.map(row => [row.from, row.to, row.kind]).sort(), [
    ['backend', 'api', 'dependsOn'], ['sessions', 'api', 'dependsOn'], ['api', 'sessions', 'communicatesWith'],
  ].sort());
  assert.ok(!graph.relations.some(row => row.from === 'history' || row.to === 'history'));
});

test('stable capability identity survives regrouping and explicit IDs disambiguate duplicate leaf names', () => {
  const first = system('stable').addStorage('oldgroup', s => s.addStore('records', x => x.dataModel('relational'))).build();
  const regrouped = system('stable').addStorage('newgroup', s => s.addStore('records', x => x.dataModel('relational'))).build();
  assert.equal(first.capabilities[0]!.id, regrouped.capabilities[0]!.id);
  assert.notEqual(first.capabilities[0]!.path, regrouped.capabilities[0]!.path);
  assert.notEqual(first.digest, regrouped.digest);
  assert.throws(() => system('duplicate').addStorage('one', s => s.addStore('records', () => undefined))
    .addStorage('two', s => s.addStore('records', () => undefined)).build(), /Duplicate capability id/);
  const explicit = system('distinct').addStorage('one', s => s.addStore('records', x => x.stableId('primary-records')))
    .addStorage('two', s => s.addStore('records', x => x.stableId('replica-records'))).build();
  assert.deepEqual(explicit.capabilities.map(row => row.id), ['primary-records', 'replica-records']);
});

test('unknown paths and wrong reference kinds fail before any product binding', () => {
  assert.throws(() => system('missing').addCompute('app', c => c.addService('api', s => s.program(artifact('api'))
    .useStorage(ref.store('data.missing'), { access: 'read' }))).build(), /Unknown capability reference/);
  assert.throws(() => system('wrongkind').addCompute('app', c => c.addService('api', s => s.program(artifact('api'))
    .useStorage(ref.store('app.api'), { access: 'read' }))).build(), /Reference kind mismatch/);
  assert.throws(() => ref.store('not-a-scoped-path'), /group.leaf/);
  assert.throws(() => system('forged').addCompute('app', c => c.addService('api', s => s.program(artifact('api'))
    .useStorage(ref.network('net.backend') as never, { access: 'read' }))), /Reference kind mismatch/);
});

test('only deployment dependencies must be acyclic; architecture communication cycles are permitted', () => {
  const design = system('communication').addCompute('app', c => c
    .addService('api', s => s.program(artifact('api')))
    .addService('worker', s => s.program(artifact('worker'))))
    .connect(ref.service('app.api'), ref.service('app.worker'), 'communicatesWith')
    .connect(ref.service('app.worker'), ref.service('app.api'), 'communicatesWith').build();
  assert.equal(design.relations.length, 2);
  assert.throws(() => system('cycle').addCompute('app', c => c
    .addService('api', s => s.program(artifact('api')))
    .addService('worker', s => s.program(artifact('worker'))))
    .dependsOn(ref.service('app.api'), ref.service('app.worker'))
    .dependsOn(ref.service('app.worker'), ref.service('app.api')).build(), /cycle/);
});

test('a service endpoint is a network capability with a declared target, not a provider product', () => {
  const design = system('endpoint').addNetwork('net', n => n.addEndpoint('web', e => e.protocol('https').port(443).target(ref.service('app.api'))))
    .addCompute('app', c => c.addService('api', v => v.program(artifact('api')))).build();
  assert.deepEqual(design.capabilities.find(row => row.id === 'web')!.properties, { protocol: 'https', port: 443, target: { kind: 'service', path: 'app.api' } });
  assert.ok(design.relations.some(row => row.from === 'api' && row.to === 'web' && row.kind === 'dependsOn'));
});

test('principals are crosscutting logical declarations rather than a fourth capability family', () => {
  const design = system('identity').principal('api', { issuer: 'operator-selected' })
    .addCompute('app', c => c.addService('api', v => v.program(artifact('api')).runAs(ref.principal('api')))).build();
  assert.equal(design.capabilities.length, 1);
  assert.equal(design.principals.length, 1);
  assert.deepEqual(design.capabilities[0]!.properties.runAs, { kind: 'principal', path: 'api' });
  assert.deepEqual(design.relations, [], 'declaring an identity does not invent grants or deployment resources');
  assert.throws(() => system('missing-principal').addCompute('app', c => c.addService('api', s => s.program(artifact('api')).runAs(ref.principal('unknown')))).build(), /Unknown principal/);
});

test('jobs and interval schedules capture intent with validated program and duration values', () => {
  const design = system('work').addCompute('tasks', c => c
    .addJob('migrate', j => j.program(artifact('migration')))
    .addScheduledTask('cleanup', t => t.program(artifact('cleanup')).schedule({ every: '1h' }))).build();
  assert.deepEqual(design.capabilities.find(row => row.id === 'cleanup')!.properties.schedule, { every: '1h' });
  assert.throws(() => system('no-program').addCompute('app', c => c.addService('api', () => undefined)).build(), /artifact/);
  assert.throws(() => system('no-schedule').addCompute('app', c => c.addScheduledTask('task', t => t.program(artifact('task')))).build(), /interval schedule/);
});

test('capability boundary memberships use stable IDs and remain declared constraints for later binding', () => {
  const design = system('boundaries').addStorage('data', s => s.addStore('records', x => x.stableId('database')))
    .boundary({ id: 'private', kind: 'security', requirements: [{ kind: 'isolation', mode: 'required' }] })
    .boundary({ id: 'room', kind: 'physical' })
    .within('private', ref.store('data.records')).within('room', ref.store('data.records')).build();
  assert.deepEqual(design.memberships.map(row => row.capabilityId), ['database', 'database']);
  assert.equal(design.boundaries.find(row => row.id === 'private')!.requirements![0]!.mode, 'required');
  assert.equal(design.capabilities[0]!.properties.isolation, undefined);
});

test('scoped callbacks close escaped builders and reject bad/foreign/async callback returns', async () => {
  let escapedStore: StoreBuilder | undefined;
  let escapedFamily: StorageScope | undefined;
  const root = system('scoped').addStorage('state', s => {
    escapedFamily = s;
    return s.addStore('records', x => { escapedStore = x; return x.dataModel('relational'); });
  });
  assert.throws(() => escapedStore!.durability('persistent'), /closed/);
  assert.throws(() => escapedFamily!.addStore('late', () => undefined), /closed/);
  const design = root.build();
  assert.throws(() => root.principal('late'), /closed/);
  assert.equal(root.build(), design);
  assert.throws(() => system('bad-return').addStorage('state', (() => 'bad') as never), /own scope/);
  let invoked = false;
  assert.throws(() => system('async').addStorage('state', (async (s: StorageScope) => { invoked = true; return s.addStore('records', () => undefined); }) as never), /synchronous/);
  assert.equal(invoked, false);
  let captured: StorageScope | undefined;
  const delayed = system('delayed');
  assert.throws(() => delayed.addStorage('state', ((s: StorageScope) => {
    captured = s;
    return Promise.resolve().then(() => s.addStore('late', () => undefined));
  }) as never), /synchronous/);
  await Promise.resolve(); await Promise.resolve();
  assert.throws(() => captured!.addStore('later', () => undefined), /closed/);
  assert.deepEqual(delayed.build().capabilities, []);
});

test('domain wrappers expand ordinary capabilities through isolated synchronous recipes', () => {
  const recipe: SystemRecipe = s => s.addStorage('state', store => store.addSessionStore('sessions', x => x.durability('persistent')));
  const composed = system('recipe').use(recipe).build();
  const direct = system('recipe').addStorage('state', store => store.addSessionStore('sessions', x => x.durability('persistent'))).build();
  assert.deepEqual(composed, direct);
  let escaped: SystemBuilder | undefined;
  system('closed-recipe').use(draft => { escaped = draft; return draft.principal('api'); }).build();
  assert.throws(() => escaped!.principal('late'), /closed/);
  const root = system('rollback');
  assert.throws(() => root.use(draft => { draft.principal('discarded'); throw new Error('recipe failed'); }), /recipe failed/);
  assert.deepEqual(root.build().principals, []);
});

test('definitions are detached, frozen, plain JSON with canonical digest and no caller mutation channel', () => {
  const principal = { labels: { owner: 'team' } };
  const builder = system('frozen').principal('api', principal).addStorage('state', s => s.addDataStore('records', () => undefined));
  principal.labels.owner = 'changed';
  const design = builder.build();
  assert.equal((design.principals[0]!.properties.labels as JsonObject).owner, 'team');
  assert.ok(Object.isFrozen(design.capabilities[0]!.properties));
  assert.ok(Object.isFrozen(design.principals[0]!.properties.labels));
  assert.throws(() => { design.capabilities[0]!.properties.durability = 'persistent'; }, TypeError);
  const roundtrip = validateSystemDesign(copied(design));
  assert.deepEqual(roundtrip, design);
  const reordered = system('frozen').addStorage('state', s => s.addDataStore('records', () => undefined))
    .principal('api', { labels: { owner: 'team' } }).build();
  assert.equal(reordered.digest, design.digest);
});

test('runtime readers reject changed digests, mismatched uses, unknown properties, duplicates and kind errors', () => {
  const original = neo();
  const changed = copied(original); changed.capabilities[0].properties.replicas = 2;
  assert.throws(() => validateSystemDesign(changed), /digest/);
  const omitted = copied(original); omitted.relations = omitted.relations.filter((row: { kind: string }) => row.kind !== 'dependsOn');
  assert.throws(() => validateSystemDesign(omitted), /omits/);
  const unknown = copied(original); unknown.capabilities[0].properties.awsProduct = 'hidden';
  assert.throws(() => validateSystemDesign(unknown), /Unknown compute property/);
  const duplicate = copied(original); duplicate.capabilities.push(duplicate.capabilities[0]);
  assert.throws(() => validateSystemDesign(duplicate), /Duplicate capability/);
  const wrong = copied(original); wrong.capabilities[0].family = 'storage';
  assert.throws(() => validateSystemDesign(wrong), /family\/kind/);
});

test('system definition admission rejects accessors and non-JSON values without invoking getters', () => {
  let invoked = false;
  const properties = Object.defineProperty({}, 'token', { enumerable: true, get() { invoked = true; return 'secret'; } });
  assert.throws(() => system('accessor').principal('api', properties), /accessors/);
  assert.equal(invoked, false);
  for (const value of [{ x: undefined }, { x: Number.NaN }, { x: new Date() }]) {
    assert.throws(() => system('bad-json').principal('api', value as unknown as JsonObject), /JSON|plain/);
  }
  const original = copied(neo());
  Object.defineProperty(original.capabilities[0], 'properties', { enumerable: true, get() { invoked = true; return {}; } });
  assert.throws(() => validateSystemDesign(original), /accessors/);
  assert.equal(invoked, false);
});

test('scope/path collisions and invalid property values are refused rather than silently normalized', () => {
  assert.throws(() => system('bad').addNetwork('net', n => n.addSegment('a')).addStorage('net', s => s.addStore('b', () => undefined)), /Duplicate capability group/);
  assert.throws(() => system('bad').addNetwork('bad.group', n => n.addSegment('a')), /without dots/);
  assert.throws(() => system('bad').addStorage('state', s => s.addStore('store', x => x.expiration({ idle: '0m' }))), /Duration/);
  assert.throws(() => system('bad').addStorage('state', s => s.addStore('store', x => x.sharing('private' as never))), /sharing/);
  assert.throws(() => system('bad').addStorage('state', s => s.addStore('store', x => x.replication({ copies: 0 }))), /positive/);
  assert.throws(() => system('bad').addStorage('state', s => s.addStore('store', x => x.expiration({}))), /at least one/);
});


test('equivalent unordered uses produce the same canonical system digest', () => {
  const make = (reverse: boolean) => system('unordered')
    .addStorage('data', s => s.addStore('a', () => undefined).addStore('b', () => undefined))
    .addNetwork('net', n => n.addSegment('one').addSegment('two'))
    .addCompute('app', c => c.addService('api', service => {
      service.program(artifact('api'));
      for (const id of reverse ? ['b', 'a'] : ['a', 'b']) service.useStorage(ref.store(`data.${id}`), { access: 'read' });
      for (const id of reverse ? ['two', 'one'] : ['one', 'two']) service.useNetwork(ref.network(`net.${id}`));
      return service;
    })).build();
  assert.deepEqual(make(false), make(true));
});

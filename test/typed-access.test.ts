import assert from 'node:assert/strict';
import test from 'node:test';
import { artifact, ref, system, why, whyPlanOperation, type PlannedOperation, type StoreHandle } from '../src/index.ts';
import { bindFleet, fleetDesign } from '../integration/neo/fleet-access.ts';

test('typed storage intent preserves the previous design and its dependency', () => {
  const typed = fleetDesign('read').design;
  const legacy = system('neo-fleet')
    .addStorage('state', group => group.addStore('fleet', file => file.dataModel('file')))
    .addCompute('application', group => group.addService('neo', workload => workload
      .program(artifact('neo-fleet')).useStorage(ref.store('state.fleet'), { access: 'read' }))).build();
  assert.deepEqual(typed, legacy);
  assert.ok(typed.relations.some(relation => relation.from === 'fleet' && relation.to === 'neo' && relation.kind === 'dependsOn'));
});

test('handles from another system or an aborted recipe cannot be used', () => {
  const app = system('isolated');
  const foreign = fleetDesign().store;
  assert.throws(() => app.addCompute('work', group => group.addService('app', leaf => leaf.uses(foreign, 'read'))), /different or discarded/);
  let stale!: StoreHandle;
  assert.throws(() => app.use(draft => {
    draft.addStorage('state', group => { stale = group.store('fleet', file => file.dataModel('file')); });
    throw Error('abort');
  }), /abort/);
  app.addStorage('state', group => group.addStore('fleet', file => file.dataModel('file')));
  assert.throws(() => app.addCompute('work', group => group.addService('app', leaf => leaf.uses(stale, 'read'))), /discarded/);
  assert.throws(() => app.addCompute('work', group => group.addService('app', leaf => {
    // @ts-expect-error Legacy string refs do not satisfy the typed .uses contract.
    leaf.uses(ref.store('state.fleet'), 'read');
  })), /Expected a typed capability handle/);
  assert.throws(() => app.addCompute('work', group => {
    // @ts-expect-error A workload handle cannot be used as a storage handle.
    group.addService('app', leaf => leaf.uses(fleetDesign().service, 'read'));
  }), /different or discarded/);
});

for (const target of [{ kind: 'kubernetes', namespace: 'neo-fleet-test' }, { kind: 'docker', source: '/local/test/manifest.json' }] as const) {
  test(`the ${target.kind} binding traces changed output fields and refuses write access`, () => {
    const { binding: before } = bindFleet(target, 'neo:test');
    const { binding, service } = bindFleet(target, 'neo:test', 'read');
    assert.throws(() => bindFleet(target, 'neo:test', 'write'), /Unsupported capability neo.*stores/);
    assert.throws(() => bindFleet(target, 'neo:test', 'readWrite'), /Unsupported capability neo.*stores/);
    const result = why(binding, service, 'stores')!;
    assert.equal(result.source.kind, 'declaration');
    assert.match(result.adapterReason!, /read-only/);
    assert.ok(result.outputs.length >= 2);
    assert.deepEqual(why({ graph: structuredClone(binding.graph) }, 'application.neo', 'stores'), result);
    assert.throws(() => why(binding, fleetDesign('read').service, 'stores'), /different or discarded/);
    const resource = binding.graph.resources.find(row => row.id === result.outputs[0]!.resourceId)!;
    const operation: PlannedOperation = { resource, action: 'update', desiredFingerprint: 'test',
      operationId: 'test', observed: { exists: true } };
    const fields = whyPlanOperation(before.graph, binding.graph, operation);
    assert.equal(fields.length, result.outputs.length);
    assert.ok(fields.every(field => field.before === undefined && field.after !== undefined && field.intentAfter?.property === 'stores'));
    assert.deepEqual(whyPlanOperation(binding.graph, binding.graph, operation), []);
    assert.deepEqual(whyPlanOperation(before.graph, binding.graph, { ...operation, action: 'verify' }), []);
    const removedResource = before.graph.resources.find(row => row.id === resource.id)!;
    const removal = whyPlanOperation(binding.graph, before.graph, { ...operation, resource: removedResource });
    assert.equal(removal.length, fields.length);
    assert.ok(removal.every(field => field.intentBefore?.property === 'stores' && field.after === undefined));
  });
}

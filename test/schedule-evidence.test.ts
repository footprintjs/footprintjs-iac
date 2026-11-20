import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileStateStore, InfraEngine, fingerprint, resourceAttribute } from '../src/core.ts';
import { backwalk, loadEvidence } from '../src/evidence.ts';
import { fingerprintPlan } from '../src/master/index.ts';
import type { ResourceAdapter, Resource } from '../src/types.ts';

const stack = { name: 'schedule-waits', resources: ['dlq', 'docs', 'jobs', 'items'].map((id): Resource => ({
  id, provider: 'fixture', spec: id === 'jobs' ? { arn: resourceAttribute('dlq', 'Arn') } : {},
  ...(id === 'jobs' && { dependsOn: ['dlq'] }),
})) };

for (const fail of [false, true]) test(`recorded schedule explains ${fail ? 'skipped parallel and serial batches' : 'capacity, the batch barrier and a resource attribute'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iac-schedule-waits-'));
  t.after(() => rm(directory, { recursive: true }));
  const saved = new Map<string, Resource>();
  const adapter: ResourceAdapter = { name: 'fixture',
    async observe(resource) {
      const actual = saved.get(resource.id);
      return actual ? { exists: true, owned: true, ready: true, fingerprint: fingerprint(actual.spec),
        attributes: { Arn: `queue:${resource.id}` } } : { exists: false };
    },
    async apply(resource) {
      if (fail && resource.id === 'docs') throw Error('Fixture failed');
      saved.set(resource.id, resource);
    },
    async waitReady() {},
    async remove() {},
  };
  const desired = fail ? { ...stack, resources: [...stack.resources, { id: 'tail', provider: 'fixture', spec: {}, dependsOn: ['items'] }] } : stack;
  const engine = new InfraEngine({ adapters: [adapter], store: new FileStateStore(directory), maxConcurrency: 2 });
  const plan = await engine.plan(desired), digest = fingerprintPlan(plan);
  const result = await engine.apply(desired, { expectedPlanDigest: digest });
  assert.equal(result.ok, !fail, result.failure?.message);
  assert.equal(fingerprintPlan(result.plan), digest);
  const evidence = await loadEvidence(result.evidencePath);
  assert.deepEqual(evidence.deploymentChart?.resources.map(row => [row.resourceId, row.batchIndex]),
    [['dlq', 0], ['docs', 0], ['jobs', 1], ['items', 1], ...(fail ? [['tail', 2]] : [])]);
  const items = backwalk(evidence, 'progress:items'), jobs = backwalk(evidence, 'progress:jobs');
  assert.match(items.text, /Capacity: batch 0 had 2 slots occupied by dlq, docs/);
  assert.deepEqual(items.schedule?.decision.dependencies, []);
  assert.match(jobs.text, /Dependency: dlq \(Arn\)/);
  assert.match(jobs.text, /Batch barrier: wait for batch 0 to settle \(dlq, docs\)/);
  assert.equal(jobs.schedule?.decision.capacity, undefined);
  assert.equal(items.schedule?.failureGate, fail);
  if (fail) {
    assert.match(items.text, /Failure gate: skipped after docs failed/);
    assert.match(backwalk(evidence, 'progress:tail').text, /Failure gate: skipped after docs failed/);
    assert.deepEqual([...saved.keys()], ['dlq']);
  } else assert.equal(saved.get('jobs')?.spec.arn, 'queue:dlq');
  const legacy = { ...evidence, deploymentChart: undefined };
  assert.equal(backwalk(legacy, 'progress:items').schedule, undefined);
});

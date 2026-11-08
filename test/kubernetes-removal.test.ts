import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/planner.ts';
import { fingerprint } from '../src/util.ts';
import type { JsonObject, Resource, ResourceAdapter, StackState } from '../src/types.ts';

test('Kubernetes field omissions and list identity removals fail before provider access', async () => {
  const resource: Resource = { id: 'app', provider: 'kubernetes', spec: {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app', namespace: 'trial' },
    spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image: 'example:v1' }] } } },
  } };
  let observations = 0;
  const adapter: ResourceAdapter = {
    name: 'kubernetes',
    observe: async () => { observations++; return { exists: true, owned: true, fingerprint: fingerprint(resource.spec) }; },
    apply: async () => { throw new Error('Unexpected mutation'); },
    remove: async () => { throw new Error('Unexpected mutation'); },
    waitReady: async () => {},
  };
  const state: StackState = { version: 1, stack: 'trial', resources: { app: { resource, fingerprint: fingerprint(resource.spec) } } };
  const variants: JsonObject[] = [
    { ...resource.spec, spec: { template: { spec: { containers: [{ name: 'app', image: 'example:v1' }] } } } },
    { ...resource.spec, spec: { replicas: 1, template: { spec: { containers: [] } } } },
    { ...resource.spec, spec: { replicas: 1, template: { spec: { containers: [{ name: 'renamed', image: 'example:v1' }] } } } },
  ];
  for (const spec of variants) {
    await assert.rejects(buildPlan({ name: 'trial', resources: [{ ...resource, spec }] }, state, new Map([['kubernetes', adapter]])), /Removing Kubernetes fields is unsupported/);
  }
  assert.equal(observations, 0);
  const changed = structuredClone(resource);
  (changed.spec.spec as Record<string, number>).replicas = 2;
  const plan = await buildPlan({ name: 'trial', resources: [changed] }, state, new Map([['kubernetes', adapter]]));
  assert.equal(plan.operations[0]?.action, 'update');
});

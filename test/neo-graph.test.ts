import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNeoGraph } from '../integration/neo/graph.ts';
import { createNeoStack } from '../integration/neo/stack.ts';
import { infra, readInfraGraph, toStack } from '../src/graph/index.ts';
import type { Resource } from '../src/types.ts';

// Artifact resources have canonical ID order; ordering comes from explicit deps.
function byId(resources: readonly Resource[]): Resource[] {
  return [...resources].sort((left, right) => left.id.localeCompare(right.id));
}

test('Neo graph preserves the exact existing resources, specs and deployment dependencies', () => {
  const source = createNeoStack();
  const graph = createNeoGraph();
  const stack = toStack(graph);
  assert.equal(stack.name, source.name);
  assert.deepEqual(byId(stack.resources), byId(source.resources));
  assert.deepEqual(byId(toStack(readInfraGraph(JSON.parse(JSON.stringify(graph)))).resources), byId(source.resources));
});

test('Neo graph passes explicit local image choices through without changing resource identities', () => {
  const options = { nodeImage: 'local/example-node:review', pythonImage: 'local/example-python:review' };
  assert.deepEqual(byId(toStack(createNeoGraph(options)).resources), byId(createNeoStack(options).resources));
});

test('Neo architecture routing does not become a reverse deployment dependency', () => {
  const graph = createNeoGraph();
  assert.deepEqual(graph.relations.filter(relation => relation.kind === 'communicatesWith'), [{
    from: 'neo-service', to: 'neo-app', kind: 'communicatesWith',
    label: 'ClusterIP routing to the selected pod on TCP 5230',
  }]);
  assert.deepEqual(toStack(graph).resources.find(entry => entry.id === 'neo-app')?.dependsOn, ['neo-namespace']);
  assert.deepEqual(toStack(graph).resources.find(entry => entry.id === 'neo-service')?.dependsOn, ['neo-app']);
});

test('Neo boundaries overlap as typed views without synthesizing security or placement enforcement', () => {
  const graph = createNeoGraph();
  const appMemberships = graph.memberships.filter(membership => membership.resourceId === 'neo-app');
  const kinds = new Set(appMemberships.map(membership => graph.boundaries.find(boundary => boundary.id === membership.boundaryId)!.kind));
  for (const kind of ['region', 'security', 'role', 'physical', 'ownership'] as const) assert.ok(kinds.has(kind));
  const security = graph.boundaries.find(boundary => boundary.kind === 'security')!;
  assert.equal(security.attributes?.enforcement, 'descriptive-only');
  const renamed = infra(graph.name).boundary({ id: 'deny-all', kind: 'security', label: 'Deny all traffic (description only)' });
  for (const entry of graph.resources) renamed.resource(entry);
  renamed.within('deny-all', ...graph.resources);
  assert.deepEqual(byId(toStack(renamed.synth()).resources), byId(createNeoStack().resources),
    'A policy-sounding boundary label must still be descriptive data.');
  const resources = toStack(graph).resources;
  assert.deepEqual(resources.map(entry => entry.spec.kind).sort(), ['Deployment', 'Namespace', 'Service']);
  assert.deepEqual(byId(resources), byId(createNeoStack().resources),
    'Boundary labels must not inject NetworkPolicy, RBAC, node affinity or any extra provider field.');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { infra, resource } from '../src/graph/index.ts';
import { graphToMermaid } from '../src/graph/render.ts';
import { graphToSvg } from '../src/graph/svg.ts';

function fixture() {
  const api = resource('api', 'simulator', { image: 'api:v1' });
  const store = resource('store', 'simulator', { image: 'store:v1' });
  return infra('render')
    .boundary({ id: 'west', kind: 'region' })
    .boundary({ id: 'restricted', kind: 'security', label: '<script>alert("x")</script>' })
    .within('west', api, store).within('restricted', store)
    .start(store).next(api)
    .connect(api, store, 'communicatesWith').connect(store, api, 'communicatesWith')
    .synth();
}

test('deployment and architecture diagrams project distinct edge meanings from the same artifact', () => {
  const graph = fixture();
  const deployment = graphToMermaid(graph, { view: 'deployment', boundaryKind: 'region' });
  const architecture = graphToMermaid(graph, { view: 'architecture', boundaryKind: 'security' });
  assert.ok(deployment.includes('region: west'));
  assert.equal(deployment.includes('communicatesWith'), false);
  assert.ok(architecture.includes('communicatesWith'));
  assert.ok(architecture.includes('&lt;script&gt;'));
  assert.equal(architecture.includes('<script>'), false);
  assert.equal(graph.resources.find(r => r.id === 'store')?.dependsOn?.includes('api') ?? false, false);
});

test('multiple memberships do not duplicate a resource in a Mermaid boundary view', () => {
  const api = resource('api', 'simulator', {});
  const graph = infra('overlap').boundary({ id: 'a', kind: 'role' }).boundary({ id: 'b', kind: 'role' })
    .within('a', api).within('b', api).synth();
  const diagram = graphToMermaid(graph, { boundaryKind: 'role' });
  assert.equal(diagram.match(/r0\["/g)?.length, 1);
  assert.ok(diagram.includes('also member of'));
});

test('standalone SVG escapes consumer labels and retains graph identity and declared-boundary meaning', () => {
  const graph = fixture();
  const svg = graphToSvg(graph, { view: 'architecture', boundaryKind: 'security' });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes(graph.digest));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.equal(svg.includes('<script>'), false);
  assert.ok(svg.includes('does not establish enforcement'));
  assert.ok(svg.includes('communicatesWith'));
});

test('renderers reject altered graph artifacts instead of independently interpreting an invalid design', () => {
  const tampered = structuredClone(fixture());
  tampered.resources[0]!.spec.image = 'changed-without-new-digest';
  assert.throws(() => graphToMermaid(tampered), /digest|fingerprint|hash/i);
  assert.throws(() => graphToSvg(tampered), /digest|fingerprint|hash/i);
});

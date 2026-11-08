import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReviewContainer, assertReviewKubeconfig, reviewTarget } from '../integration/neo/setup/target.ts';
import { readReviewImages, reviewImageTag } from '../integration/neo/setup/images.ts';

test('portable review isolates its kubeconfig and persistent state from the existing test deployment', () => {
  const portable = reviewTarget('/library', 'kind-footprint-iac-review');
  const existing = reviewTarget('/library', 'kind-footprint-iac-test');
  assert.equal(portable.kubeconfig, '/library/.artifacts/kubeconfig-review');
  assert.equal(existing.kubeconfig, '/library/.artifacts/kubeconfig');
  assert.equal(portable.stateDirectory, '/library/.artifacts/neo/review/state');
  assert.equal(existing.stateDirectory, undefined, 'preserve the original per-run state behavior');
  for (const context of ['production', 'kind-other', '', '--context=prod']) {
    assert.throws(() => reviewTarget('/library', context), /only kind-footprint/);
  }
});

test('review cluster refuses a same-named container owned by another cluster or role', () => {
  const labels = { 'io.x-k8s.kind.cluster': 'footprint-iac-review', 'io.x-k8s.kind.role': 'control-plane' };
  assert.doesNotThrow(() => assertReviewContainer(labels));
  for (const value of [null, {}, { ...labels, 'io.x-k8s.kind.cluster': 'footprint-iac-test' },
    { ...labels, 'io.x-k8s.kind.role': 'worker' }]) {
    assert.throws(() => assertReviewContainer(value), /not owned/);
  }
});

function kubeconfig() {
  return {
    'current-context': 'kind-footprint-iac-review',
    contexts: [{ name: 'kind-footprint-iac-review', context: { cluster: 'kind-footprint-iac-review' } }],
    clusters: [{ name: 'kind-footprint-iac-review', cluster: { server: 'https://127.0.0.1:43101' } }],
    users: [{ user: { 'client-certificate-data': 'redacted', 'client-key-data': 'redacted' } }],
  };
}

test('exported review credentials must address one loopback kind target and cannot execute authentication helpers', () => {
  assert.doesNotThrow(() => assertReviewKubeconfig(kubeconfig()));
  for (const server of ['https://production.example:6443', 'http://127.0.0.1:6443', 'https://127.0.0.1.attacker:6443']) {
    const value = kubeconfig(); value.clusters[0]!.cluster.server = server;
    assert.throws(() => assertReviewKubeconfig(value), /loopback/);
  }
  const wrongContext = kubeconfig(); wrongContext['current-context'] = 'production';
  assert.throws(() => assertReviewKubeconfig(wrongContext), /loopback/);
  const extraCluster = kubeconfig(); extraCluster.clusters.push({ name: 'production', cluster: { server: 'https://production:6443' } });
  assert.throws(() => assertReviewKubeconfig(extraCluster), /loopback/);
  for (const helper of ['exec', 'auth-provider']) {
    const value = kubeconfig(); Object.assign(value.users[0]!.user, { [helper]: { command: 'unexpected' } });
    assert.throws(() => assertReviewKubeconfig(value), /loopback/);
  }
});

test('review image identities change with rebuilt bytes and reject truncated or injected Docker identities', () => {
  const first = reviewImageTag('node', 'sha256:' + 'a'.repeat(64));
  assert.equal(first, 'footprint-iac/neo-node:review-' + 'a'.repeat(64));
  assert.notEqual(first, reviewImageTag('node', 'sha256:' + 'b'.repeat(64)));
  assert.notEqual(first, reviewImageTag('python', 'sha256:' + 'a'.repeat(64)));
  for (const id of ['sha256:abcdef', 'sha256:' + 'a'.repeat(64) + '\n--privileged', 'image:latest']) {
    assert.throws(() => reviewImageTag('node', id), /complete Docker/);
  }
});

test('review refuses image metadata from a different Neo source snapshot or arbitrary image tag', t => {
  const root = mkdtempSync(join(tmpdir(), 'neo-review-images-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.artifacts/neo'); mkdirSync(directory, { recursive: true });
  const sourceCommit = 'a'.repeat(40);
  const images = { sourceCommit, nodeImage: reviewImageTag('node', 'sha256:' + 'b'.repeat(64)),
    pythonImage: reviewImageTag('python', 'sha256:' + 'c'.repeat(64)) };
  const save = (value: unknown) => writeFileSync(join(directory, 'review-images.json'), JSON.stringify(value));
  save(images);
  assert.deepEqual(readReviewImages(root, sourceCommit), images);
  assert.throws(() => readReviewImages(root, 'd'.repeat(40)), /do not match/);
  save({ ...images, nodeImage: 'somewhere/arbitrary:latest' });
  assert.throws(() => readReviewImages(root, sourceCommit), /do not match/);
});

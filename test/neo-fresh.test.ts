import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFreshContainer, assertFreshKubeconfig, freshTargetPaths } from '../integration/neo/fresh/target.ts';
import { parseNeoSourceTree } from '../integration/neo/fresh/source.ts';

test('source manifest preserves legitimate filenames while refusing path escape and nonregular entries', () => {
  const blobId = 'a'.repeat(40);
  const paths = ['be-server/web/design/SEO Chat UI.dc.html', 'src/évidence.ts', 'src/tab\tfile.ts'];
  const tree = paths.map(path => `100644 blob ${blobId}\t${path}\0`).join('');
  assert.deepEqual(parseNeoSourceTree(tree), paths.map(path => ({ path, blobId })));
  for (const record of [`120000 blob ${blobId}\tsrc/link\0`, `100644 blob ${blobId}\t../outside\0`,
    `100644 blob ${blobId}\t/absolute\0`, `100644 blob ${blobId}\tsrc/./other\0`]) {
    assert.throws(() => parseNeoSourceTree(record), /regular committed/);
  }
});

test('fresh recording targets isolate credentials and inventory per unique cluster', () => {
  const first = freshTargetPaths('/library', '1234abcd');
  const next = freshTargetPaths('/library', 'fedcba98');
  assert.equal(first.context, 'kind-footprint-iac-recording-1234abcd');
  assert.equal(first.kubeconfig, '/library/.artifacts/neo/fresh/1234abcd/kubeconfig');
  assert.equal(first.stateDirectory, '/library/.artifacts/neo/fresh/1234abcd/state');
  assert.notEqual(first.clusterName, next.clusterName);
  assert.notEqual(first.kubeconfig, next.kubeconfig);
  assert.notEqual(first.stateDirectory, next.stateDirectory);
  for (const suffix of ['', '1234567', '123456789', '../other', '1234ABCD', '--name=x']) {
    assert.throws(() => freshTargetPaths('/library', suffix), /eight lowercase hexadecimal/);
  }
});

test('a container from any other cluster or role cannot identify a fresh recording target', () => {
  const cluster = 'footprint-iac-recording-1234abcd';
  const labels = { 'io.x-k8s.kind.cluster': cluster, 'io.x-k8s.kind.role': 'control-plane' };
  assert.doesNotThrow(() => assertFreshContainer(labels, cluster));
  for (const value of [null, {}, [], { ...labels, 'io.x-k8s.kind.cluster': 'footprint-iac-test' },
    { ...labels, 'io.x-k8s.kind.role': 'worker' }]) {
    assert.throws(() => assertFreshContainer(value, cluster), /dedicated kind cluster/);
  }
  assert.throws(() => assertFreshContainer(labels, 'footprint-iac-test'), /dedicated kind cluster/);
});

function credentials() {
  const context = 'kind-footprint-iac-recording-1234abcd';
  return {
    'current-context': context,
    contexts: [{ name: context, context: { cluster: context, user: context } }],
    clusters: [{ name: context, cluster: { server: 'https://127.0.0.1:43101' } }],
    users: [{ name: context, user: { 'client-certificate-data': 'redacted', 'client-key-data': 'redacted' } }],
  };
}

test('fresh credentials reject context mixing, external clusters and executable authentication', () => {
  const context = 'kind-footprint-iac-recording-1234abcd';
  assert.doesNotThrow(() => assertFreshKubeconfig(credentials(), context));
  for (const server of ['https://production.example:6443', 'http://127.0.0.1:6443', 'https://127.0.0.1.attacker:6443']) {
    const value = credentials(); value.clusters[0]!.cluster.server = server;
    assert.throws(() => assertFreshKubeconfig(value, context), /dedicated loopback/);
  }
  const switched = credentials(); switched['current-context'] = 'kind-footprint-iac-test';
  assert.throws(() => assertFreshKubeconfig(switched, context), /dedicated loopback/);
  const wrongUser = credentials(); wrongUser.contexts[0]!.context.user = 'other';
  assert.throws(() => assertFreshKubeconfig(wrongUser, context), /dedicated loopback/);
  const extraCluster = credentials(); extraCluster.clusters.push({ name: 'other', cluster: { server: 'https://127.0.0.1:43102' } });
  assert.throws(() => assertFreshKubeconfig(extraCluster, context), /dedicated loopback/);
  for (const helper of ['exec', 'auth-provider']) {
    const value = credentials(); Object.assign(value.users[0]!.user, { [helper]: { command: 'unexpected' } });
    assert.throws(() => assertFreshKubeconfig(value, context), /dedicated loopback/);
  }
});

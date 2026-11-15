import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFactsDigest } from '../src/platform-access/facts.ts';
import type { HostFactsSnapshot } from '../src/platform-access/types.ts';
import { HOST_PREPARATION_CHECKS, PinnedRecipeHostPreparation } from '../src/platform-bootstrap/pinned-preparation.ts';

const facts = (): HostFactsSnapshot => {
  const value: Omit<HostFactsSnapshot, 'digest'> = { version: 1, kind: 'host-facts',
    host: { id: 'host-a', scope: 'management', profileId: 'management-profile' }, observedAt: Date.now(), status: 'partial', identityDigest: 'a'.repeat(64),
    os: { family: 'linux', distribution: 'debian', version: '12', kernel: '6.1.0' }, architecture: 'amd64', cpuCount: 4,
    memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 },
    disk: { path: '/', totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3 }, privilege: 'root',
    tools: { kubeadm: { status: 'absent' }, kubelet: { status: 'absent' }, kubectl: { status: 'absent' }, containerd: { status: 'absent' } },
    kubernetes: { status: 'unknown' } };
  return { ...value, digest: hostFactsDigest(value) };
};
const intent = { id: 'new-cluster', mode: 'create' as const, topology: { version: '1.37.0', nodes: [{ hostId: 'host-a', role: 'control-plane' as const }] } };
const context = { executionId: 'run-1', operationId: 'assess-1', completedActionIds: [] };
const recipe = { hostId: 'host-a', id: 'prepare-host-a', recipePath: '/opt/site/reviewed-install.sh', recipeSha256: 'b'.repeat(64) };

test('preparation observation retains only registered recipes, measured safe checks and physical identity', async () => {
  const adapter = new PinnedRecipeHostPreparation({ id: 'site-installer', recipes: [recipe], probe: { async inspect() {
    return { status: 'preparable', observedAt: Date.now(), checks: HOST_PREPARATION_CHECKS.map(id => ({ id, passed: !['packages', 'runtime'].includes(id) })) };
  } } });
  const assessment = await adapter.inspect(facts(), intent, context);
  assert.equal(assessment.status, 'preparable');
  assert.equal(assessment.identityDigest, 'a'.repeat(64));
  assert.equal(assessment.recipeDigest, adapter.recipeDigest);
  assert.equal(assessment.actions.length, 1);
  assert.equal(assessment.actions[0]?.id, 'prepare-host-a');
  assert.equal(assessment.actions[0]?.phase, 'prepare');
  assert.equal(JSON.stringify(assessment).includes(recipe.recipePath), false);
  assert.equal(JSON.stringify(assessment).includes('script'), false);
  assert.equal(adapter.hostActions('host-a')[0]?.effect, 'mutating');
});

test('private probe failures and additional output cannot enter preparation evidence or approve a recipe', async () => {
  const sentinel = 'private-password-sentinel';
  for (const inspect of [async () => { throw new Error(sentinel); }, async () => ({ status: 'ready', checks: [], password: sentinel })]) {
    const adapter = new PinnedRecipeHostPreparation({ id: 'site-installer', recipes: [recipe], probe: { inspect: inspect as never } });
    const assessment = await adapter.inspect(facts(), intent, context);
    assert.equal(assessment.status, 'unknown');
    assert.equal(assessment.checks.every(check => !check.passed), true);
    assert.equal(JSON.stringify(assessment).includes(sentinel), false);
  }
});

test('missing physical identity and unregistered host stop before probing the target', async () => {
  let calls = 0;
  const adapter = new PinnedRecipeHostPreparation({ id: 'site-installer', recipes: [recipe], probe: { async inspect() {
    calls++; return { status: 'ready', observedAt: Date.now(), checks: HOST_PREPARATION_CHECKS.map(id => ({ id, passed: true })) };
  } } });
  const unknown = facts(); unknown.identityDigest = null;
  const { digest: _digest, ...withoutDigest } = unknown; unknown.digest = hostFactsDigest(withoutDigest);
  await assert.rejects(adapter.inspect(unknown, intent, context));
  const other = facts(); other.host.id = 'host-b'; const { digest: _other, ...otherValue } = other; other.digest = hostFactsDigest(otherValue);
  await assert.rejects(adapter.inspect(other, { ...intent, topology: { ...intent.topology, nodes: [{ hostId: 'host-b', role: 'control-plane' }] } }, context));
  assert.equal(calls, 0);
});

test('a cached site observation retains its measurement age for the mandatory freshness check', async () => {
  const measuredAt = 1;
  const adapter = new PinnedRecipeHostPreparation({ id: 'site-installer', recipes: [recipe], probe: { async inspect() {
    return { status: 'ready', observedAt: measuredAt, checks: HOST_PREPARATION_CHECKS.map(id => ({ id, passed: true })) };
  } } });
  const assessment = await adapter.inspect(facts(), intent, context);
  assert.equal(assessment.observedAt, measuredAt);
});

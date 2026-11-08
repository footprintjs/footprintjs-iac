import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, ProviderContext, Resource } from '../src/types.ts';
import { KubernetesAdapter, type CommandOptions, type CommandRunner } from '../src/providers/kubernetes.ts';
import { fingerprint } from '../src/util.ts';

const context: ProviderContext = { stack: 'demo', operationId: 'operation-1' };
const config: Resource = {
  id: 'settings', provider: 'kubernetes',
  spec: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'iac-test' }, data: { greeting: 'hello' } },
};

type Call = { command: string; args: readonly string[]; options: CommandOptions };
function fake(responses: (string | Error)[]) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('Unexpected command');
    return { stdout: next };
  };
  return { calls, runner };
}

function owned(resource = config): JsonObject {
  const live = structuredClone(resource.spec);
  const metadata = live.metadata as JsonObject;
  metadata.uid = 'uid-1';
  metadata.resourceVersion = '5';
  metadata.annotations = {
    'footprint-iac.dev/owner': fingerprint({ stack: context.stack, id: resource.id }),
    'footprint-iac.dev/stack': context.stack,
    'footprint-iac.dev/resource': resource.id,
  };
  return live;
}

test('Kubernetes requires an explicit context and namespace, and refuses unsupported manifests', async () => {
  assert.throws(() => new KubernetesAdapter({ context: '' }), /explicit Kubernetes context/);
  const adapter = new KubernetesAdapter({ context: 'local', runner: fake([]).runner });
  await assert.rejects(adapter.observe({ ...config, spec: { ...config.spec, kind: 'Secret' } }, context), /Unsupported/);
  await assert.rejects(adapter.observe({ ...config, spec: { ...config.spec, metadata: { name: 'x' } } }, context), /explicit namespace/);
  await assert.rejects(adapter.observe({ ...config, spec: { ...config.spec, metadata: { name: 'x', namespace: 'iac-test', uid: 'bad' } } }, context), /runtime field uid/);
});

test('Kubernetes treats only an empty successful get as absent; forbidden and transport errors propagate', async () => {
  const missing = fake(['']);
  const adapter = new KubernetesAdapter({ context: 'local', namespace: 'iac-test', runner: missing.runner });
  assert.deepEqual(await adapter.observe(config, context), { exists: false, physicalId: 'kubernetes://local/api/v1/namespaces/iac-test/configmaps/settings' });
  assert.deepEqual(missing.calls[0]!.args.slice(0, 6), ['--context', 'local', '--request-timeout', '120s', '--namespace', 'iac-test']);
  assert.ok(missing.calls[0]!.args.includes('--ignore-not-found=true'));
  const forbidden = new KubernetesAdapter({ context: 'local', runner: fake([new Error('Forbidden')]).runner });
  await assert.rejects(forbidden.observe(config, context), /Forbidden/);
});

test('Kubernetes detects live drift and ignores server defaults inside declared container lists', async () => {
  const deployment: Resource = {
    id: 'app', provider: 'kubernetes',
    spec: {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app', namespace: 'iac-test' },
      spec: { replicas: 1, selector: { matchLabels: { app: 'demo' } }, template: {
        metadata: { labels: { app: 'demo' } },
        spec: { containers: [{ name: 'app', image: 'example:v1', ports: [{ containerPort: 8080 }] }] },
      } },
    },
  };
  const live = owned(deployment);
  const liveSpec = live.spec as JsonObject;
  const podSpec = ((liveSpec.template as JsonObject).spec as JsonObject);
  const containers = podSpec.containers as JsonObject[];
  containers[0]!.imagePullPolicy = 'IfNotPresent';
  ((containers[0]!.ports as JsonObject[])[0]!).protocol = 'TCP';
  liveSpec.strategy = { type: 'RollingUpdate' };
  (live.metadata as JsonObject).generation = 1;
  live.status = { observedGeneration: 1, updatedReplicas: 1, availableReplicas: 1, replicas: 1 };
  const defaults = new KubernetesAdapter({ context: 'local', runner: fake([JSON.stringify(live)]).runner });
  const observed = await defaults.observe(deployment, context);
  assert.equal(observed.fingerprint, fingerprint(deployment.spec));
  assert.equal(observed.owned, true);
  assert.equal(observed.ready, true);
  containers[0]!.image = 'example:drifted';
  const drifted = new KubernetesAdapter({ context: 'local', runner: fake([JSON.stringify(live)]).runner });
  assert.notEqual((await drifted.observe(deployment, context)).fingerprint, fingerprint(deployment.spec));
});

test('Kubernetes refuses a namespace escape and managing reserved namespaces', async () => {
  const adapter = new KubernetesAdapter({ context: 'local', namespace: 'local-only', runner: fake([]).runner });
  await assert.rejects(adapter.observe(config, context), /namespace differs/);
  await assert.rejects(adapter.observe({ id: 'ns', provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default' } } }, context), /reserved namespace/);
});

test('Kubernetes refuses modifying or deleting an unowned existing resource', async () => {
  const transport = fake([JSON.stringify(config.spec), JSON.stringify(config.spec)]);
  const adapter = new KubernetesAdapter({ context: 'local', runner: transport.runner });
  await assert.rejects(adapter.apply(config, context), /unowned/);
  await assert.rejects(adapter.remove(config, context), /unowned/);
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.calls.every(call => call.args.includes('get')));
});

test('Kubernetes creates absent targets without upserting over a concurrent unowned object', async () => {
  const transport = fake(['', new Error('AlreadyExists')]);
  const adapter = new KubernetesAdapter({ context: 'local', runner: transport.runner });
  await assert.rejects(adapter.apply(config, context), /AlreadyExists/);
  assert.ok(transport.calls[1]!.args.includes('create'));
  assert.ok(!transport.calls[1]!.args.includes('apply'));
  const sent = JSON.parse(transport.calls[1]!.options.input!) as JsonObject;
  assert.equal(((sent.metadata as JsonObject).annotations as JsonObject)['footprint-iac.dev/stack'], 'demo');
});

test('Kubernetes updates use server-side apply with mutation preconditions and no force conflicts', async () => {
  const transport = fake([JSON.stringify(owned()), '{}']);
  const adapter = new KubernetesAdapter({ context: 'local', runner: transport.runner });
  await adapter.apply(config, context);
  const apply = transport.calls[1]!;
  assert.ok(apply.args.includes('apply'));
  assert.ok(apply.args.includes('--server-side=true'));
  assert.ok(!apply.args.includes('--force-conflicts'));
  const sent = JSON.parse(apply.options.input!) as JsonObject;
  assert.equal((sent.metadata as JsonObject).uid, 'uid-1');
  assert.equal((sent.metadata as JsonObject).resourceVersion, '5');
});

test('Kubernetes migrates only its own create manager after an SSA conflict with exact preconditions', async () => {
  const live = owned();
  (live.metadata as JsonObject).managedFields = [{
    manager: 'footprint-iac', operation: 'Update', apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1: { 'f:data': { 'f:greeting': {} } },
  }, {
    manager: 'controller', operation: 'Update', subresource: 'status', apiVersion: 'v1', fieldsType: 'FieldsV1',
    fieldsV1: { 'f:status': { 'f:ready': {} }, 'f:metadata': { 'f:annotations': { 'f:controller.example/revision': {} } } },
  }];
  const transport = fake([JSON.stringify(live), new Error('Apply failed with 1 conflict: conflict with "footprint-iac"'), '{}']);
  const adapter = new KubernetesAdapter({ context: 'local', runner: transport.runner });
  await adapter.apply(config, context);
  assert.ok(transport.calls[0]!.args.includes('--show-managed-fields=true'));
  assert.ok(!transport.calls[1]!.args.includes('--force-conflicts=true'));
  assert.ok(transport.calls[2]!.args.includes('--force-conflicts=true'));
  assert.equal(transport.calls[1]!.options.input, transport.calls[2]!.options.input);
  const metadata = (JSON.parse(transport.calls[2]!.options.input!) as JsonObject).metadata as JsonObject;
  assert.equal(metadata.uid, 'uid-1');
  assert.equal(metadata.resourceVersion, '5');
});

test('Kubernetes never forces another main-resource manager or an overlapping status-owned field', async () => {
  const bootstrap: JsonObject = {
    manager: 'footprint-iac', operation: 'Update', apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1: { 'f:data': { 'f:greeting': {} } },
  };
  const foreignEntries: JsonObject[] = [{
    manager: 'another-tool', operation: 'Apply', apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1: { 'f:data': { 'f:greeting': {} } },
  }, {
    manager: 'controller', operation: 'Update', subresource: 'status', apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1: { 'f:data': { 'f:greeting': {} } },
  }];
  for (const other of foreignEntries) {
    const live = owned();
    (live.metadata as JsonObject).managedFields = [bootstrap, other];
    const transport = fake([JSON.stringify(live), new Error('Apply failed with 1 conflict')]);
    await assert.rejects(new KubernetesAdapter({ context: 'local', runner: transport.runner }).apply(config, context), /conflict/);
    assert.equal(transport.calls.length, 2, 'foreign ownership must not be forced');
  }
});

test('Kubernetes bootstrap migration never retries a validation error or ignores stale preconditions', async () => {
  const live = owned();
  (live.metadata as JsonObject).managedFields = [{
    manager: 'footprint-iac', operation: 'Update', apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1: { 'f:data': { 'f:greeting': {} } },
  }];
  const invalid = fake([JSON.stringify(live), new Error('Invalid: replicas must be greater than or equal to 0')]);
  await assert.rejects(new KubernetesAdapter({ context: 'local', runner: invalid.runner }).apply(config, context), /Invalid/);
  assert.equal(invalid.calls.length, 2);
  const stale = fake([JSON.stringify(live), new Error('Apply conflict with footprint-iac'), new Error('Conflict: resourceVersion changed')]);
  await assert.rejects(new KubernetesAdapter({ context: 'local', runner: stale.runner }).apply(config, context), /resourceVersion changed/);
  assert.equal(stale.calls.length, 3);
});

test('Kubernetes delete sends atomic UID/version preconditions and waits; namespace deletion is refused', async () => {
  const transport = fake([JSON.stringify(owned()), '{}', 'deleted']);
  const adapter = new KubernetesAdapter({ context: 'local', runner: transport.runner });
  await adapter.remove(config, context);
  const deletion = transport.calls[1]!;
  assert.ok(deletion.args.includes('/api/v1/namespaces/iac-test/configmaps/settings'));
  assert.deepEqual(JSON.parse(deletion.options.input!).preconditions, { uid: 'uid-1', resourceVersion: '5' });
  assert.ok(transport.calls[2]!.args.includes('--for=delete'));
  await assert.rejects(adapter.remove({ id: 'ns', provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'iac-test' } } }, context), /Namespace deletion is unsupported/);
});

test('Kubernetes readiness waits on deployment rollout and verifies final live readiness', async () => {
  const deployment: Resource = {
    id: 'app', provider: 'kubernetes', spec: { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app', namespace: 'iac-test' }, spec: { replicas: 1 } },
  };
  const initial = owned(deployment);
  (initial.metadata as JsonObject).generation = 2;
  initial.status = { observedGeneration: 1, updatedReplicas: 1, availableReplicas: 1, replicas: 1 };
  const ready = structuredClone(initial);
  ready.status = { observedGeneration: 2, updatedReplicas: 1, availableReplicas: 1, replicas: 1 };
  const transport = fake([JSON.stringify(initial), 'rolled out', JSON.stringify(ready)]);
  const adapter = new KubernetesAdapter({ context: 'local', runner: transport.runner });
  await adapter.waitReady(deployment, context);
  assert.ok(transport.calls[1]!.args.includes('rollout'));
  const lying = new KubernetesAdapter({ context: 'local', runner: fake([JSON.stringify(initial), 'rolled out', JSON.stringify(initial)]).runner });
  await assert.rejects(lying.waitReady(deployment, context), /did not become ready/);
});

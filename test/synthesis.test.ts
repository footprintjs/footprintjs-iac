import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';
import { findLastWriter, stateAt } from 'foottrace';
import { bindSystem } from '../src/binding/index.ts';
import { compileGraph } from '../src/graph/compile.ts';
import type { InfraGraph } from '../src/graph/types.ts';
import { system } from '../src/system/index.ts';
import type { Resource } from '../src/types.ts';
import { fingerprint } from '../src/util.ts';
import { orderResources } from '../src/planner.ts';
import { createNeoSystem } from '../integration/neo/system.ts';
import { neoKubernetesProfile } from '../integration/neo/kubernetes-profile.ts';
import { awsObjectStorageProfile, cloudFormationLogicalId, cloudFormationOutput, kubernetesOutput, outputResourceRef, synthesize, SynthesisError } from '../src/synthesis/index.ts';
import type { OutputAdapter, OutputArtifact } from '../src/synthesis/index.ts';
import { sha256 } from '../src/synthesis/artifact.ts';

function neo() { return bindSystem(createNeoSystem(), neoKubernetesProfile({ context: 'kind-synthesis-fixture' })).graph; }
function graph(resources: Resource[]) { return compileGraph({ name: 'output-fixture', resources, boundaries: [], memberships: [], relations: [] }); }
function cloudBucket(id = 'bucket'): Resource { return { id, provider: 'aws-cloudformation', spec: { Type: 'AWS::S3::Bucket', Properties: {} } }; }
function transformed(base: OutputAdapter, change: (value: OutputArtifact) => OutputArtifact): OutputAdapter {
  return { id: base.id, create(model) { const recorder = base.create(model); return { ...recorder, finalize: () => change(recorder.finalize()) }; } };
}

test('native recorder synthesis emits the complete Neo desired model as JSON and YAML with original capability mappings', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No provider calls belong in synthesis'); });
  const model = neo();
  const events: string[] = [];
  const result = await synthesize(model, { outputs: [kubernetesOutput(), kubernetesOutput({ format: 'yaml' })],
    recorders: [{ id: 'test-observer', onEmit(event) { events.push(event.name); } }] });
  assert.equal(events.filter(name => name === 'iac.synthesis.resource').length, 3);
  assert.equal(result.graphDigest, model.digest);
  assert.equal(result.artifacts.length, 2);
  const json = JSON.parse(result.artifacts[0]!.files[0]!.content);
  const yaml = parse(result.artifacts[1]!.files[0]!.content);
  assert.deepEqual(json, yaml);
  assert.equal(json.kind, 'List'); assert.equal(json.items.length, 3);
  assert.deepEqual(json.items, orderResources(model.resources).map(resource => JSON.parse(JSON.stringify(resource.spec))));
  assert.deepEqual(result.artifacts[0]!.mappings.map(row => row.resourceId).sort(), model.resources.map(resource => resource.id));
  assert.ok(result.artifacts[0]!.mappings.every(row => row.capabilityId && row.capabilityPath && row.designDigest));
  assert.ok(result.artifacts[0]!.limitations.some(value => value.includes('readiness sequencing')));
  assert.deepEqual(stateAt(result.snapshot, result.snapshot.commitLog.length - 1).state, result.snapshot.sharedState);
  for (const mapping of result.artifacts[0]!.mappings) {
    const writer = findLastWriter(result.snapshot.commitLog, mapping.sourceKey);
    assert.ok(writer); assert.match(writer.runtimeStageId!, /^emit-/);
  }
  const last = findLastWriter(result.snapshot.commitLog, 'artifacts');
  assert.match(last!.runtimeStageId!, /^finalize-outputs/);
  assert.equal(result.snapshot.recorders?.some(row => row.id === 'kubernetes-json'), true);
});

test('outputs are deterministic across repeated compilation and equivalent JSON property ordering', async () => {
  const first = graph([{ id: 'namespace', provider: 'kubernetes', spec: { kind: 'Namespace', apiVersion: 'v1', metadata: { name: 'test' } } }]);
  const second = graph([{ id: 'namespace', provider: 'kubernetes', spec: { metadata: { name: 'test' }, apiVersion: 'v1', kind: 'Namespace' } }]);
  assert.equal(first.digest, second.digest);
  const a = await synthesize(first, { outputs: [kubernetesOutput()] });
  const b = await synthesize(second, { outputs: [kubernetesOutput()] });
  assert.deepEqual(a.artifacts, b.artifacts);
});

test('artifact admission rejects tampered graphs and accessors before any output callback', async () => {
  let called = 0;
  const output: OutputAdapter = { id: 'never', create() { called++; throw new Error('must not run'); } };
  const changed = structuredClone(neo()); changed.name = 'changed';
  await assert.rejects(synthesize(changed, { outputs: [output] }), /digest/);
  let getterCalls = 0;
  const accessor = { ...neo() }; Object.defineProperty(accessor, 'resources', { enumerable: true, get() { getterCalls++; return []; } });
  await assert.rejects(synthesize(accessor, { outputs: [output] }), /accessors/);
  assert.equal(getterCalls, 0); assert.equal(called, 0);
});

test('output backends reject incompatible bindings and Kubernetes removal-retention that manifests cannot encode', async () => {
  await assert.rejects(synthesize(neo(), { outputs: [cloudFormationOutput()] }), /CloudFormation binding/);
  await assert.rejects(synthesize(graph([cloudBucket()]), { outputs: [kubernetesOutput()] }), /Kubernetes binding/);
  const retained = structuredClone(neo().resources);
  retained[0]!.lifecycle = { retainOnRemoval: true };
  await assert.rejects(synthesize(graph(retained), { outputs: [kubernetesOutput()] }), /cannot express.*retention/);
});

test('duplicate native Kubernetes identities are refused rather than overwritten', async () => {
  const resource = { provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'same' } } };
  await assert.rejects(synthesize(graph([{ id: 'one', ...resource }, { id: 'two', ...resource }]), { outputs: [kubernetesOutput()] }), /Duplicate native/);
});

test('Kubernetes output puts declared prerequisites first even when stable IDs sort in the opposite order', async () => {
  const model = graph([
    { id: 'a-config', provider: 'kubernetes', dependsOn: ['z-namespace'], spec: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'config', namespace: 'fixture' }, data: { message: 'hello' } } },
    { id: 'z-namespace', provider: 'kubernetes', spec: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'fixture' } } },
  ]);
  const result = await synthesize(model, { outputs: [kubernetesOutput()] });
  const items = JSON.parse(result.artifacts[0]!.files[0]!.content).items;
  assert.deepEqual(items.map((item: { kind: string }) => item.kind), ['Namespace', 'ConfigMap']);
  assert.deepEqual(result.artifacts[0]!.mappings.map(row => row.nativePath), ['/items/0', '/items/1']);
});

test('AWS object-storage binding is explicit, narrow and export-only, with native retention policies', async () => {
  const design = system('object-system').addStorage('state', stores => stores.addStore('documents', store => store
    .dataModel('object').durability('persistent').sharing('shared').retainOnRemoval())).build();
  const binding = bindSystem(design, awsObjectStorageProfile({ accountId: '123456789012', region: 'us-east-1' }));
  assert.equal(binding.target.properties!.mode, 'export-only');
  assert.ok(binding.decisions[0]!.requirements.every(row => row.status === 'implemented' && /not observed/.test(row.reason)));
  const result = await synthesize(binding.graph, { outputs: [cloudFormationOutput(), cloudFormationOutput({ format: 'yaml' })] });
  const template = JSON.parse(result.artifacts[0]!.files[0]!.content);
  const resource = Object.values(template.Resources)[0] as Record<string, any>;
  assert.equal(resource.Type, 'AWS::S3::Bucket');
  assert.equal(resource.DeletionPolicy, 'Retain'); assert.equal(resource.UpdateReplacePolicy, 'Retain');
  assert.equal(resource.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
  assert.equal(resource.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.deepEqual(parse(result.artifacts[1]!.files[0]!.content), template);
  assert.equal(result.artifacts[0]!.validation, 'structural');
  assert.ok(result.artifacts[0]!.limitations.some(value => /no AWS API/.test(value)));
});

test('AWS profile rejects unsupported expiry, replication, model and missing account identity', () => {
  const profile = awsObjectStorageProfile({ accountId: '123456789012', region: 'us-east-1' });
  for (const unsupported of ['expiration', 'replication', 'relational']) {
    const design = system('unsupported').addStorage('state', stores => stores.addStore('data', store => {
      store.dataModel(unsupported === 'relational' ? 'relational' : 'object').durability('persistent');
      if (unsupported === 'expiration') store.expiration({ absolute: '1d' });
      if (unsupported === 'replication') store.replication({ copies: 2 });
    })).build();
    assert.throws(() => bindSystem(design, profile), /Unsupported|No binding/);
  }
  assert.throws(() => awsObjectStorageProfile({ accountId: 'default', region: 'us-east-1' }), /explicit 12-digit/);
});

test('CloudFormation symbolic references, attributes and deployment order map to stable native logical IDs', async () => {
  const model = graph([cloudBucket(), {
    id: 'bucket-arn', provider: 'aws-cloudformation', dependsOn: ['bucket'],
    spec: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: outputResourceRef('bucket', 'Arn') } },
  }]);
  const result = await synthesize(model, { outputs: [cloudFormationOutput()] });
  const template = JSON.parse(result.artifacts[0]!.files[0]!.content);
  const child = template.Resources[cloudFormationLogicalId('bucket-arn')];
  assert.deepEqual(child.DependsOn, [cloudFormationLogicalId('bucket')]);
  assert.deepEqual(child.Properties.Value, { 'Fn::GetAtt': [cloudFormationLogicalId('bucket'), 'Arn'] });
});

test('CloudFormation missing references, unsupported intrinsics and retained dependency closure fail before export', async () => {
  for (const value of [outputResourceRef('absent'), { Ref: 'missing' }, { 'Fn::Sub': '${Missing}' }]) {
    await assert.rejects(synthesize(graph([{ ...cloudBucket(), spec: { Type: 'AWS::S3::Bucket', Properties: { BucketName: value } } }]), { outputs: [cloudFormationOutput()] }), /reference|Ref|intrinsic/);
  }
  await assert.rejects(synthesize(graph([cloudBucket(), { ...cloudBucket('retained'), dependsOn: ['bucket'], lifecycle: { retainOnRemoval: true } }]), { outputs: [cloudFormationOutput()] }), /dependency closure/);
});

test('implicit native reference cycles cannot pass a source graph with no explicit dependency edges', async () => {
  const one = { ...cloudBucket('one'), spec: { Type: 'AWS::S3::Bucket', Properties: { BucketName: outputResourceRef('two') } } };
  const two = { ...cloudBucket('two'), spec: { Type: 'AWS::S3::Bucket', Properties: { BucketName: outputResourceRef('one') } } };
  await assert.rejects(synthesize(graph([one, two]), { outputs: [cloudFormationOutput()] }), /dependency cycle/);
  await assert.rejects(synthesize(graph([{ ...cloudBucket(), spec: { Type: 'AWS::S3::Bucket', Properties: { BucketName: outputResourceRef('bucket') } } }]), { outputs: [cloudFormationOutput()] }), /dependency cycle/);
});

test('a throwing output observer cannot be swallowed into a successful synthesis', async () => {
  const broken: OutputAdapter = { id: 'broken', create() { return { id: 'broken', onEmit() { throw new Error('projection broke'); }, finalize() { throw new Error('must not finalize'); } }; } };
  await assert.rejects(synthesize(neo(), { outputs: [broken] }), error => {
    assert.ok(error instanceof SynthesisError);
    assert.match(error.message, /incomplete.*projection broke/);
    assert.equal(error.evidence.snapshot.sharedState.artifacts, undefined);
    const bundle = error.evidence.snapshot.recorders!.find(row => row.id === 'broken')!;
    assert.ok(JSON.stringify(bundle.data).includes('projection broke'));
    return true;
  });
});

test('finalization rejects missing coverage, forged hashes and unsafe output paths', async () => {
  const changes: ((artifact: OutputArtifact) => OutputArtifact)[] = [
    artifact => ({ ...artifact, mappings: [] }),
    artifact => ({ ...artifact, files: artifact.files.map(file => ({ ...file, sha256: '0'.repeat(64) })) }),
    artifact => ({ ...artifact, files: artifact.files.map(file => ({ ...file, path: '../outside.json' })) }),
  ];
  for (const change of changes) await assert.rejects(synthesize(neo(), { outputs: [transformed(kubernetesOutput(), change)] }), /coverage|hash|Unsafe/);
});

test('valid hashes cannot admit invalid encoded files or mismatched media types', async () => {
  const invalid = transformed(kubernetesOutput(), artifact => ({ ...artifact, files: artifact.files.map(file => ({ ...file, content: 'not-json', sha256: sha256('not-json') })) }));
  await assert.rejects(synthesize(neo(), { outputs: [invalid] }), /JSON/);
  const wrongType = transformed(kubernetesOutput(), artifact => ({ ...artifact, files: artifact.files.map(file => ({ ...file, mediaType: 'text/javascript' })) }));
  await assert.rejects(synthesize(neo(), { outputs: [wrongType] }), /media type/);
});

test('async output callbacks, duplicate adapters and colliding output paths fail closed', async () => {
  let invoked = 0;
  const asynchronous = { id: 'async', create: async () => { invoked++; return {}; } } as unknown as OutputAdapter;
  await assert.rejects(synthesize(neo(), { outputs: [asynchronous] }), /synchronous/); assert.equal(invoked, 0);
  await assert.rejects(synthesize(neo(), { outputs: [kubernetesOutput(), kubernetesOutput()] }), /Duplicate output adapter/);
  const second: OutputAdapter = { id: 'same-path', create(model) {
    const native = kubernetesOutput().create(model);
    return { ...native, id: 'same-path', finalize: () => ({ ...native.finalize(), adapterId: 'same-path' }) };
  } };
  await assert.rejects(synthesize(neo(), { outputs: [kubernetesOutput(), second] }), /duplicate file paths/);
});

test('required boundaries remain unsupported at the synthesis entry point', async () => {
  const body = structuredClone(neo());
  body.boundaries.push({ id: 'isolation', kind: 'security', requirements: [{ kind: 'network-isolation', mode: 'required' }] });
  const { digest: ignored, ...rest } = body;
  const model: InfraGraph = { ...rest, digest: fingerprint(rest) };
  await assert.rejects(synthesize(model, { outputs: [kubernetesOutput()] }), /Unsupported required boundary/);
});

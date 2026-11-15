# Recorded output adapters

The public synthesis layer turns a validated, complete desired resource graph into native files without provider observation or deployment. Binding still chooses concrete technology. A Kubernetes graph can produce Kubernetes manifests; an AWS CloudFormation binding produces CloudFormation templates. Changing JSON to YAML does not change the platform.

```ts
import { synthesize, kubernetesOutput } from 'footprintjs-iac/synthesis';

const result = await synthesize(binding.graph, {
  outputs: [kubernetesOutput(), kubernetesOutput({ format: 'yaml' })],
});
// result.artifacts contains files, SHA-256 hashes, native/source mappings and limitations.
// result.snapshot + result.structure can be opened by Flow Lens.
```

Synthesis uses a native FootPrint flowchart: validate desired model, emit every desired resource, then finalize and validate outputs. Each output adapter creates an `EmitRecorder` that consumes `iac.synthesis.resource` events. A caller can also attach native `CombinedRecorder` observers through `recorders`. Output recorder failures are collected and explicitly rejected by finalization, because ordinary observer exceptions are intentionally isolated by FootPrint.

The complete desired model is always exported, independently of create/update/no-op decisions from a later deployment. Failed compilation throws `SynthesisError`, which carries its native evidence and an explicit recorded failure. No partial artifact is returned. Exported source mappings preserve full resource and originating capability IDs and identify the tracked `resource:<id>` state key. These are resource-level mappings; emitting a nested object does not establish field-level causal provenance automatically.

## Kubernetes

`kubernetesOutput({ format: 'json' | 'yaml' })` emits a native `v1/List` containing each desired object in declared dependency order, so an explicitly declared Namespace prerequisite comes first. It rejects foreign providers, duplicate native identities, live `status` data and removal retention that cannot be represented by ordinary manifests. The resulting files can be reviewed with existing Kubernetes tooling.

Manifest files do not encode our direct engine's readiness sequencing, recovery strategy or ownership inventory. Switching deployment owners requires a deliberate migration. Structural generation does not establish Kubernetes schema admission, authorization or readiness.

## Narrow AWS CloudFormation profile

```ts
import { system } from 'footprintjs-iac/system';
import { bindSystem } from 'footprintjs-iac/binding';
import { awsObjectStorageProfile, cloudFormationOutput, synthesize } from 'footprintjs-iac/synthesis';

const design = system('archive').addStorage('state', storage => storage
  .addStore('documents', store => store
    .dataModel('object').sharing('shared').durability('persistent')
    .retainOnRemoval())).build();

const binding = bindSystem(design, awsObjectStorageProfile({
  accountId: '123456789012', // Example target identity; no credentials.
  region: 'us-east-1',
}));
const result = await synthesize(binding.graph, {
  outputs: [cloudFormationOutput({ format: 'yaml' })],
});
```

This profile implements **template lowering only** for explicit persistent object storage using `AWS::S3::Bucket`. It blocks public access and requests AES256 server-side encryption in the generated resource. Optional sharing must be `shared`; purpose is descriptive. Expiration, replication, relational/session models and other unsupported requirements are rejected. Its `implemented` support claim is compiler implementation, never observed AWS verification. The target records `mode: 'export-only'`.

`cloudFormationOutput` produces stable native logical IDs, source mappings and native `DependsOn`. `outputResourceRef(resourceId, attribute?)` resolves declared symbolic resource references to `Ref` or `Fn::GetAtt`; unknown references and unsupported intrinsics fail. Removal retention maps to both `DeletionPolicy` and `UpdateReplacePolicy`; retained resources with dependencies are rejected because the emitter cannot preserve the framework's saved dependency-closure policy. S3 deletion can fail when a bucket contains objects.

AWS output receives **local structural validation only**. No AWS API call, authentication, account/region verification, schema service, quota check or live deployment occurs. Review the files with AWS tooling before a separately authorized deployment. Parameters, conditions, transforms, general AWS compute/network bindings and an AWS deployment driver are outside this first profile. Terraform output is an extension point, not an implemented exporter.

AWS native shape references: [S3 bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-s3-bucket.html), [public-access block](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-s3-bucket-publicaccessblockconfiguration.html), [encryption](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-s3-bucket-serversideencryptionbydefault.html).

Run `node examples/synthesis.ts` directly to save both the real Neo desired manifests and the narrow AWS example under `.artifacts/synthesis/run-*`. This is file generation only. Local generated evidence and output remain excluded from Git.

## Adding an output

Implement `OutputAdapter` with an ID and a synchronous `create(graph)` method. Return an `OutputRecorder` with the same ID, an `onEmit` projection and `finalize()`. Finalization returns an `OutputArtifact` with files, exact resource coverage and source mappings. The framework validates paths, hashes, JSON shape, graph identity, output coverage and file collisions before accepting it. Callbacks are trusted compiler extensions; they are not a sandbox. Keep backend lowering, reference translation and output encoding in small owning modules, and keep flowchart construction in its dedicated file.

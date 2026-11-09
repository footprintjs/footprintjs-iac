import { keys } from '../graph/data.ts';
import { readProfile } from '../binding/profile.ts';
import type { BindingProfile, CapabilityAdapter, RequirementSupport } from '../binding/types.ts';
import type { Capability } from '../system/types.ts';
import type { JsonObject } from '../types.ts';
import { optionsRow } from './artifact.ts';

function requirements(capability: Capability) {
  const unsupported: string[] = [];
  const assessments: RequirementSupport[] = [];
  const values: Record<string, unknown> = { dataModel: 'object', durability: 'persistent', sharing: 'shared' };
  for (const [property, requested] of Object.entries(capability.properties)) {
    const supported = property in values ? requested === values[property]
      : property === 'purpose' ? typeof requested === 'string'
        : property === 'retention' && requested !== null && typeof requested === 'object' && !Array.isArray(requested)
          && Object.keys(requested).every(key => key === 'onRemoval')
          && ['retain', 'delete'].includes(String((requested as JsonObject).onRemoval));
    if (!supported) unsupported.push(property);
    assessments.push({ property, requested, status: 'implemented', reason: 'CloudFormation template lowering only; not observed AWS verification.' });
  }
  for (const property of ['dataModel', 'durability']) if (capability.properties[property] !== values[property]) unsupported.push(property);
  return { supported: unsupported.length === 0 && capability.family === 'storage' && capability.kind === 'store',
    reason: 'Narrow export-only S3 binding for explicit persistent object storage; no credentials or provider calls.',
    unsupportedRequirements: [...new Set(unsupported)], requirements: assessments };
}

/** An explicitly scoped compiler profile, not an AWS deployment adapter. */
export function awsObjectStorageProfile(options: { accountId: string; region: string }): BindingProfile {
  const row = optionsRow(options); keys(row, ['accountId', 'region'], 'AWS object storage profile options');
  if (typeof row.accountId !== 'string' || !/^[0-9]{12}$/.test(row.accountId)) throw new Error('AWS target requires an explicit 12-digit account id');
  if (typeof row.region !== 'string' || !/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/.test(row.region)) throw new Error('AWS target requires an explicit region');
  const adapter: CapabilityAdapter = {
    id: 'aws-s3-cloudformation-export', mode: 'real', supports: requirements,
    lower(capability, context) {
      const retention = capability.properties.retention as JsonObject | undefined;
      return { resources: [{
        id: context.resourceId('bucket'), provider: 'aws-cloudformation',
        spec: { Type: 'AWS::S3::Bucket', Properties: {
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
          BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        } },
        ...(retention?.onRemoval === undefined ? {} : { lifecycle: { retainOnRemoval: retention.onRemoval === 'retain' } }),
      }] };
    },
  };
  return readProfile({
    id: 'aws-object-storage-export', target: { id: `aws-${row.accountId}-${row.region}`, properties: { accountId: row.accountId, region: row.region, backend: 'cloudformation', mode: 'export-only' } },
    rules: [{ id: 'object-storage', family: 'storage', kind: 'store', properties: { dataModel: 'object', durability: 'persistent' }, adapterId: adapter.id }],
    adapters: [adapter], artifacts: {},
  });
}

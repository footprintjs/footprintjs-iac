import { keys } from '../graph/data.ts';
import type { JsonObject, Resource } from '../types.ts';
import { artifactMapping, optionsRow, outputFile, outputFormat } from './artifact.ts';
import { resourceCollector } from './recorder.ts';
import { cloudFormationLogicalId, resolveCloudFormationRefs } from './references.ts';
import { validateCloudFormationDependencies } from './cloudformation-dependencies.ts';
import type { OutputAdapter, OutputFormat } from './types.ts';

function nativeResource(resource: Resource, logicalIds: ReadonlyMap<string, string>): JsonObject {
  if (resource.provider !== 'aws-cloudformation') throw new Error('CloudFormation output requires an AWS CloudFormation binding');
  keys(resource.spec, ['Type', 'Properties', 'Metadata'], 'CloudFormation resource');
  if (typeof resource.spec.Type !== 'string' || !/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(resource.spec.Type)) throw new Error('Invalid AWS CloudFormation resource type');
  if (resource.spec.Properties !== undefined && (!resource.spec.Properties || typeof resource.spec.Properties !== 'object' || Array.isArray(resource.spec.Properties))) throw new Error('CloudFormation Properties must be an object');
  const spec = resolveCloudFormationRefs(resource.spec, logicalIds) as JsonObject;
  if (resource.dependsOn?.length) spec.DependsOn = resource.dependsOn.map(id => logicalIds.get(id)!);
  if (resource.lifecycle?.retainOnRemoval !== undefined) {
    spec.DeletionPolicy = resource.lifecycle.retainOnRemoval ? 'Retain' : 'Delete';
    spec.UpdateReplacePolicy = resource.lifecycle.retainOnRemoval ? 'Retain' : 'Delete';
  }
  return spec;
}

export function cloudFormationOutput(options: { format?: OutputFormat } = {}): OutputAdapter {
  const row = optionsRow(options); keys(row, ['format'], 'CloudFormation output options');
  const format = outputFormat(row.format ?? 'json');
  const id = 'cloudformation-' + format;
  return {
    id,
    create(graph) {
      if (!graph.resources.length) throw new Error('CloudFormation output requires resources');
      const logicalIds = new Map(graph.resources.map(resource => [resource.id, cloudFormationLogicalId(resource.id)]));
      if (new Set(logicalIds.values()).size !== logicalIds.size) throw new Error('Native logical ID collision');
      const native = new Map(graph.resources.map(resource => [resource.id, nativeResource(resource, logicalIds)]));
      validateCloudFormationDependencies(graph.resources, native, logicalIds);
      return resourceCollector(id, graph, resources => ({
        adapterId: id, format, graphDigest: graph.digest, validation: 'structural',
        files: [outputFile(`cloudformation.${format}`, {
          AWSTemplateFormatVersion: '2010-09-09',
          Metadata: { FootprintGraphDigest: graph.digest },
          Resources: Object.fromEntries(resources.map(resource => [logicalIds.get(resource.id)!, nativeResource(resource, logicalIds)])),
        }, format)],
        mappings: resources.map(resource => artifactMapping(graph, resource.id, logicalIds.get(resource.id)!, `/Resources/${logicalIds.get(resource.id)!}`)),
        limitations: ['Export only: no AWS API, account authorization, quota, resource-schema or live deployment validation has run.',
          'Ref and Fn::GetAtt are supported; parameters, conditions, transforms and other intrinsics are unsupported.',
          'Each resource needs one deployment owner; exported files do not adopt existing direct-engine resources.',
          'Native Retain/Delete policies govern CloudFormation removal and replacement; nonempty S3 buckets may refuse deletion.'],
      }));
    },
  };
}

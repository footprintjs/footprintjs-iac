import { identifier, jsonCopy, object } from '../graph/data.ts';
import type { Json, JsonObject } from '../types.ts';
import { fingerprint } from '../util.ts';

/** Native identifiers are derived; the complete source identity remains in the source map. */
export function cloudFormationLogicalId(resourceId: string): string {
  identifier(resourceId, 'CloudFormation source resource id');
  return 'Resource' + fingerprint({ resourceId }).slice(0, 40);
}
/** A symbolic reference remains data until the backend-specific emitter resolves it. */
export function outputResourceRef(resourceId: string, attribute?: string): JsonObject {
  identifier(resourceId, 'output reference');
  if (attribute !== undefined && !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(attribute)) throw new Error('Invalid output attribute');
  return { $iacRef: resourceId, ...(attribute === undefined ? {} : { attribute }) };
}
const pseudo = new Set(['AWS::AccountId', 'AWS::NotificationARNs', 'AWS::NoValue', 'AWS::Partition', 'AWS::Region', 'AWS::StackId', 'AWS::StackName', 'AWS::URLSuffix']);

export function resolveCloudFormationRefs(input: Json, logicalIds: ReadonlyMap<string, string>): Json {
  if (Array.isArray(input)) return input.map(value => resolveCloudFormationRefs(value, logicalIds));
  if (!input || typeof input !== 'object') return input;
  const row = object(jsonCopy(input), 'CloudFormation value');
  const nativeIds = new Set(logicalIds.values());
  if ('$iacRef' in row) {
    if (Object.keys(row).some(key => !['$iacRef', 'attribute'].includes(key)) || typeof row.$iacRef !== 'string') throw new Error('Invalid symbolic output reference');
    const id = logicalIds.get(row.$iacRef);
    if (!id) throw new Error('Missing output reference: ' + row.$iacRef);
    if (row.attribute === undefined) return { Ref: id };
    if (typeof row.attribute !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(row.attribute)) throw new Error('Invalid reference attribute');
    return { 'Fn::GetAtt': [id, row.attribute] };
  }
  if ('Ref' in row) {
    if (Object.keys(row).length !== 1 || typeof row.Ref !== 'string' || (!nativeIds.has(row.Ref) && !pseudo.has(row.Ref))) throw new Error('Missing or unsupported native CloudFormation Ref');
    return row;
  }
  if ('Fn::GetAtt' in row) {
    const value = row['Fn::GetAtt'];
    if (Object.keys(row).length !== 1 || !Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string'
      || !nativeIds.has(value[0]) || typeof value[1] !== 'string') throw new Error('Invalid or missing CloudFormation GetAtt target');
    return row;
  }
  if (Object.keys(row).some(key => key.startsWith('Fn::'))) throw new Error('Unsupported CloudFormation intrinsic; this emitter supports Ref and Fn::GetAtt');
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, resolveCloudFormationRefs(value, logicalIds)]));
}

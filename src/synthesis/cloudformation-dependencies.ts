import { validateDependencies } from '../graph/resources.ts';
import type { Json, JsonObject, Resource } from '../types.ts';

/** Native references also imply deployment edges, even without an explicit DependsOn. */
export function validateCloudFormationDependencies(resources: readonly Resource[], native: ReadonlyMap<string, JsonObject>, logicalIds: ReadonlyMap<string, string>): void {
  const sourceByNative = new Map([...logicalIds].map(([source, id]) => [id, source]));
  function references(value: Json, found: Set<string>) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) references(item, found); return; }
    if (typeof value.Ref === 'string' && sourceByNative.has(value.Ref)) found.add(sourceByNative.get(value.Ref)!);
    const getAtt = value['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string' && sourceByNative.has(getAtt[0])) found.add(sourceByNative.get(getAtt[0])!);
    for (const item of Object.values(value)) references(item, found);
  }
  const resolved = resources.map(resource => {
    const found = new Set(resource.dependsOn ?? []);
    references(native.get(resource.id)!, found);
    return { ...resource, dependsOn: [...found] };
  });
  validateDependencies(resolved);
  // Any ancestor path begins with a direct resolved edge. Neither explicit
  // DependsOn nor implicit Ref/GetAtt ancestors may escape retention admission.
  if (resolved.some(resource => resource.lifecycle?.retainOnRemoval === true && resource.dependsOn.length)) {
    throw new Error('CloudFormation export cannot preserve framework retained dependency closure');
  }
}

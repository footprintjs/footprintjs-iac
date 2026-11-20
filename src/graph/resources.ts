import type { Resource } from '../types.ts';
import { readResourceLifecycle } from '../resource-lifecycle.ts';
import { hasResourceAttributes } from '../resource-attributes.ts';
import { array, freeze, identifier, jsonCopy, keys, object } from './data.ts';

export function readResource(input: unknown): Resource {
  const row = object(jsonCopy(input), 'resource');
  keys(row, ['id', 'provider', 'spec', 'dependsOn', 'lifecycle'], 'resource');
  const id = identifier(row.id, 'resource id');
  const provider = identifier(row.provider, 'provider');
  const spec = object(row.spec!, `resource ${id} spec`);
  const lifecycle = readResourceLifecycle(row.lifecycle);
  const dependsOn = row.dependsOn === undefined ? [] : array(row.dependsOn, 'dependsOn').map(value => identifier(value, 'dependency'));
  if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Duplicate dependency for ${id}`);
  return { id, provider, spec, ...(lifecycle === undefined ? {} : { lifecycle }), ...(dependsOn.length ? { dependsOn: dependsOn.sort() } : {}) };
}

/** Resource handles are detached, frozen declarations; creating one never calls a provider. */
export function resource(id: string, provider: string, spec: Resource['spec'], dependsOn?: string[]): Resource {
  return freeze(readResource({ id, provider, spec, ...(dependsOn === undefined ? {} : { dependsOn }) }));
}

export function validateDependencies(resources: readonly Resource[]): void {
  const byId = new Map(resources.map(row => [row.id, row]));
  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const row of resources) {
    hasResourceAttributes(row);
    waiting.set(row.id, row.dependsOn?.length ?? 0);
    for (const source of row.dependsOn ?? []) {
      if (!byId.has(source)) throw new Error(`Unknown resource dependency: ${source}`);
      const children = dependents.get(source) ?? [];
      children.push(row.id);
      dependents.set(source, children);
    }
  }
  const ready = resources.filter(row => waiting.get(row.id) === 0).map(row => row.id);
  for (let index = 0; index < ready.length; index++) {
    for (const child of dependents.get(ready[index]!) ?? []) {
      const left = waiting.get(child)! - 1;
      waiting.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  if (ready.length !== resources.length) throw new Error(`Deployment dependency cycle at ${resources.find(row => waiting.get(row.id)! > 0)!.id}`);
}

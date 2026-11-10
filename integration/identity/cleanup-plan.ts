import { freeze, jsonCopy, object } from '../../src/graph/data.ts';
import { readResource } from '../../src/graph/resources.ts';
import type { Resource, Stack, StackState } from '../../src/types.ts';
import type { IdentityTarget } from './target.ts';

/** Keep the admitted namespace as protected intent; cleanup must never cascade through it. */
export function identityCleanupStack(targetInput: Pick<IdentityTarget, 'id' | 'namespace'>, stateInput: StackState): Stack {
  try {
    const target = object(jsonCopy(targetInput), 'cleanup target');
    const id = target.id;
    if (typeof id !== 'string' || !/^[a-f0-9]{8}$/.test(id)
      || target.namespace !== `footprint-iac-identity-${id}`) throw Error();
    const state = object(jsonCopy(stateInput), 'cleanup inventory');
    const name = `neo-identity-${id}`;
    if (state.version !== 1 || state.stack !== name) throw Error();
    const resources = object(state.resources!, 'cleanup resources');
    let namespace: Resource | undefined, namespacedWork = false;
    for (const [key, entry] of Object.entries(resources)) {
      const resource = readResource(object(entry, 'managed cleanup resource').resource);
      if (resource.id !== key) throw Error();
      if (key === 'identity-directory' || key === 'identity-provider') {
        const role = key === 'identity-directory' ? 'directory' : 'provider';
        if (resource.provider !== 'local-identity-fixture' || resource.spec.name !== `footprint-identity-${id}-${role}`
          || resource.spec.role !== role) throw Error();
        continue;
      }
      const metadata = object(resource.spec.metadata!, 'cleanup metadata');
      if (resource.provider !== 'kubernetes') throw Error();
      if (key === 'neo-namespace') {
        if (resource.spec.kind !== 'Namespace' || resource.spec.apiVersion !== 'v1'
          || metadata.name !== target.namespace || metadata.namespace !== undefined || resource.dependsOn?.length) throw Error();
        namespace = resource;
        continue;
      }
      const kind = { 'neo-access-policy': 'ConfigMap', 'neo-app': 'Deployment', 'neo-service': 'Service' }[key];
      if (!kind || resource.spec.kind !== kind || metadata.namespace !== target.namespace
        || metadata.name !== (key === 'neo-access-policy' ? 'neo-access-policy' : 'neo')
        || resource.spec.apiVersion !== (kind === 'Deployment' ? 'apps/v1' : 'v1')) throw Error();
      namespacedWork = true;
    }
    if (namespacedWork && !namespace) throw Error();
    const kept = namespace ? [{ ...namespace, lifecycle: { ...namespace.lifecycle, retainOnRemoval: true } }] : [];
    return freeze({ name, resources: kept });
  } catch { throw new Error('Invalid identity cleanup inventory'); }
}

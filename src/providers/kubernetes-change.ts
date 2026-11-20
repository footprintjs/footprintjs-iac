import type { Resource, ResourceChangeAssessment } from '../types.ts';
import { fingerprint } from '../util.ts';

/** Initial POST field ownership is distinct from SSA ownership. Until full migration is supported,
 * reject removals rather than accept a projection that hides an omitted-but-still-live field. */
function removedField(previous: unknown, desired: unknown, path = 'spec'): string | undefined {
  if (Array.isArray(previous)) {
    if (!Array.isArray(desired) || desired.length < previous.length) return path;
    for (let i = 0; i < previous.length; i++) {
      const oldItem = previous[i];
      const newItem = desired[i];
      if (oldItem && typeof oldItem === 'object' && !Array.isArray(oldItem)
        && typeof oldItem.name === 'string' && oldItem.name !== newItem?.name) return `${path}[${i}].name`;
      const nested = removedField(oldItem, newItem, `${path}[${i}]`);
      if (nested) return nested;
    }
  } else if (previous && typeof previous === 'object') {
    if (!desired || typeof desired !== 'object' || Array.isArray(desired)) return path;
    for (const [key, value] of Object.entries(previous)) {
      if (!Object.hasOwn(desired, key)) return `${path}.${key}`;
      const nested = removedField(value, (desired as Record<string, unknown>)[key], `${path}.${key}`);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function assessKubernetesChange(previous: Resource, desired: Resource): ResourceChangeAssessment {
  const identity = (resource: Resource) => {
    const metadata = resource.spec.metadata as Record<string, unknown> | undefined;
    return [resource.spec.apiVersion, resource.spec.kind, metadata?.name, metadata?.namespace ?? null];
  };
  if (fingerprint(identity(previous)) !== fingerprint(identity(desired))) {
    return { disposition: 'replace', reason: 'Kubernetes resource identity changed. Use a new resource ID and explicit prune.' };
  }
  const removal = removedField(previous.spec, desired.spec);
  if (removal) return {
    disposition: 'replace',
    reason: 'Removing Kubernetes fields is unsupported in this prototype (' + desired.id + ': ' + removal + '). Plan an explicit replacement.',
  };
  return { disposition: 'update' };
}

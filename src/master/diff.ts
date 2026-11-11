import { freeze } from '../graph/data.ts';
import { canonical } from '../util.ts';
import type { Json } from '../types.ts';
import { readSystemRevision } from './revision.ts';
import type { ResourceChange, SystemRevision, SystemRevisionChanges } from './types.ts';

function paths(previous: Json | undefined, next: Json | undefined, path = ''): string[] {
  if (canonical(previous) === canonical(next)) return [];
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object'
    || Array.isArray(previous) || Array.isArray(next)) return [path || '$'];
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort().flatMap(key =>
    paths(previous[key], next[key], path ? `${path}.${key}` : key));
}
/** Declaration differences only. Actual drift and readiness are supplied separately by engine.plan. */
export function diffSystemRevisions(previous: SystemRevision | null | undefined, candidate: SystemRevision): SystemRevisionChanges {
  const before = previous ? readSystemRevision(previous) : undefined, after = readSystemRevision(candidate);
  if (before && (before.graph.name !== after.graph.name || canonical(before.target) !== canonical(after.target))) throw Error('System revisions belong to different stack/target bindings');
  const old = new Map(before?.graph.resources.map(resource => [resource.id, resource]) ?? []);
  const desired = new Map(after.graph.resources.map(resource => [resource.id, resource]));
  const resources: ResourceChange[] = [...new Set([...old.keys(), ...desired.keys()])].sort().map(resourceId => {
    const a = old.get(resourceId), b = desired.get(resourceId);
    const changed = a && b ? paths(a as unknown as Json, b as unknown as Json) : ['$'];
    return { resourceId, kind: !a ? 'added' : !b ? 'removed' : changed.length ? 'changed' : 'unchanged', paths: changed };
  });
  return freeze({ previousDigest: before?.digest ?? null, candidateDigest: after.digest,
    graphChanged: before?.graph.digest !== after.graph.digest,
    metadataChanged: !before || canonical({ source: before.source ?? null, artifacts: before.artifacts ?? [] })
      !== canonical({ source: after.source ?? null, artifacts: after.artifacts ?? [] }),
    resources, counts: { added: resources.filter(row => row.kind === 'added').length,
      changed: resources.filter(row => row.kind === 'changed').length, removed: resources.filter(row => row.kind === 'removed').length,
      unchanged: resources.filter(row => row.kind === 'unchanged').length } });
}

import type { InfraGraph } from '../graph/types.ts';
import type { JsonObject } from '../types.ts';

const shortText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function readOrigin(attributes: JsonObject | undefined) {
  if (!attributes || attributes.origin !== 'capability') return undefined;
  const { designDigest, capabilityId, capabilityPath, capabilityFamily, capabilityKind, adapterId, mode } = attributes;
  if (!digest(designDigest) || !shortText(capabilityId) || !shortText(capabilityPath) || !shortText(adapterId)
    || !['compute', 'storage', 'network'].includes(String(capabilityFamily)) || !shortText(capabilityKind)
    || (mode !== 'simulation' && mode !== 'real')) return undefined;
  return {
    designDigest, capabilityId, capabilityPath, family: capabilityFamily as string, kind: capabilityKind,
    adapterId, mode, status: 'declared' as const,
  };
}

/** Compilation metadata connects recorded resources to intent; it does not prove an adapter's guarantees. */
export function capabilityOrigins(graph: InfraGraph, resourceId: string | undefined) {
  const boundaries = new Map(graph.boundaries.map(boundary => [boundary.id, boundary]));
  const candidates = graph.memberships.filter(member => member.resourceId === resourceId)
    .map(member => boundaries.get(member.boundaryId)!)
    .filter(boundary => boundary.attributes?.origin === 'capability');
  const recognized = candidates.map(boundary => readOrigin(boundary.attributes)).filter(origin => origin !== undefined);
  return {
    origins: recognized.slice(0, 16),
    omittedOriginCount: Math.max(0, recognized.length - 16),
    unreadOriginCount: candidates.length - recognized.length,
  };
}

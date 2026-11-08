import type { Segment, SegmentGroup } from './types.ts';
import { freeze, identifier, jsonCopy } from './data.ts';
import { readResource } from './resources.ts';

function detachedSegment(input: Segment, active = new Set<object>(), depth = 0): Segment {
  if (depth > 64) throw new Error('Flow grouping exceeds maximum depth');
  if (typeof input === 'string') return identifier(input, 'resource reference');
  if (!input || typeof input !== 'object') throw new Error('Invalid flow segment');
  if ('kind' in input) {
    if (active.has(input)) throw new Error('Cyclic flow grouping');
    if (input.kind !== 'serial-group' && input.kind !== 'parallel-group') throw new Error('Invalid flow group kind');
    if (!Array.isArray(input.segments) || input.segments.length === 0) throw new Error('Flow groups require at least one segment');
    active.add(input);
    const segments = input.segments.map(segment => detachedSegment(segment, active, depth + 1));
    active.delete(input);
    return { kind: input.kind, segments };
  }
  return readResource(input);
}
export function serialGroup(...segments: Segment[]): SegmentGroup {
  return freeze(copySegment({ kind: 'serial-group', segments })) as SegmentGroup;
}
export function parallelGroup(...segments: Segment[]): SegmentGroup {
  return freeze(copySegment({ kind: 'parallel-group', segments })) as SegmentGroup;
}
export function copySegment(segment: Segment): Segment { return detachedSegment(jsonCopy(segment) as unknown as Segment); }

import type { Json } from '../types.ts';
import type { Boundary, BoundaryKind, BoundaryRequirement } from './types.ts';
import { canonical } from '../util.ts';
import { array, identifier, keys, object, text } from './data.ts';

const kinds: readonly BoundaryKind[] = ['region', 'security', 'role', 'physical', 'ownership', 'group'];
export function readBoundary(input: Json): Boundary {
  const row = object(input, 'boundary');
  keys(row, ['id', 'kind', 'label', 'parent', 'attributes', 'requirements'], 'boundary');
  const id = identifier(row.id, 'boundary id');
  if (!kinds.includes(row.kind as BoundaryKind)) throw new Error(`Invalid boundary kind for ${id}`);
  const requirements = row.requirements === undefined ? [] : array(row.requirements, 'boundary requirements').map(value => {
    const item = object(value, 'boundary requirement');
    keys(item, ['kind', 'mode', 'value'], 'requirement');
    if (item.mode !== 'required' && item.mode !== 'advisory') throw new Error(`Invalid requirement mode in ${id}`);
    return {
      kind: identifier(item.kind, 'requirement kind'), mode: item.mode,
      ...(Object.hasOwn(item, 'value') ? { value: item.value! } : {}),
    } satisfies BoundaryRequirement;
  });
  const signatures = requirements.map(canonical);
  if (new Set(signatures).size !== signatures.length) throw new Error(`Duplicate requirement in ${id}`);
  requirements.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  return {
    id, kind: row.kind as BoundaryKind,
    ...(row.label === undefined ? {} : { label: text(row.label, 'boundary label') }),
    ...(row.parent === undefined ? {} : { parent: identifier(row.parent, 'boundary parent') }),
    ...(row.attributes === undefined ? {} : { attributes: object(row.attributes, 'boundary attributes') }),
    ...(requirements.length ? { requirements } : {}),
  };
}

/** Nest one facet, or use a generic group; separate facets overlap through memberships. */
export function validateBoundaryParents(boundaries: readonly Boundary[]): void {
  const byId = new Map(boundaries.map(row => [row.id, row]));
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>();
  const ready: string[] = [];
  for (const row of boundaries) {
    if (!row.parent) {
      depth.set(row.id, 1);
      ready.push(row.id);
      continue;
    }
    const parent = byId.get(row.parent);
    if (!parent) throw new Error(`Unknown boundary parent: ${row.parent}`);
    if (parent.kind !== 'group' && parent.kind !== row.kind) throw new Error(`Incompatible boundary parent kinds: ${row.kind} under ${parent.kind}`);
    const nested = children.get(parent.id) ?? [];
    nested.push(row.id);
    children.set(parent.id, nested);
  }
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]!;
    for (const child of children.get(id) ?? []) {
      const childDepth = depth.get(id)! + 1;
      if (childDepth > 64) throw new Error('Boundary nesting exceeds maximum depth of 64');
      depth.set(child, childDepth);
      ready.push(child);
    }
  }
  if (ready.length !== boundaries.length) {
    throw new Error(`Boundary parent cycle at ${boundaries.find(row => !depth.has(row.id))!.id}`);
  }
}

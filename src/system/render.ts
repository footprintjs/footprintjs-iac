import { compileGraph } from '../graph/compile.ts';
import { graphToMermaid, type GraphViewOptions } from '../graph/render.ts';
import { graphToSvg } from '../graph/svg.ts';
import type { Boundary, Membership, Relation } from '../graph/types.ts';
import type { SystemDesign } from './types.ts';
import { validateSystemDesign } from './validation.ts';

/** Private diagram projection: conceptual capabilities are not provider resources. */
function viewGraph(input: SystemDesign) {
  const design = validateSystemDesign(input);
  const boundaries: Boundary[] = [...design.boundaries];
  const memberships: Membership[] = design.memberships.map(member => ({ resourceId: member.capabilityId, boundaryId: member.boundaryId }));
  const ids = new Set(boundaries.map(boundary => boundary.id));
  const groupIds = new Map<string, string>();
  function group(key: string, label: string, parent?: string): string {
    const existing = groupIds.get(key);
    if (existing) return existing;
    const base = `view-${design.digest.slice(0, 12)}-${groupIds.size}`;
    let id = base;
    for (let index = 2; ids.has(id); index++) id = `${base}-${index}`;
    ids.add(id); groupIds.set(key, id);
    boundaries.push({ id, kind: 'group', label, ...(parent ? { parent } : {}), attributes: { view: 'composition', key } });
    return id;
  }
  for (const capability of design.capabilities) {
    const family = group(capability.family, capability.family);
    const scope = capability.path.slice(0, capability.path.lastIndexOf('.'));
    const parent = scope ? group(`${capability.family}/${scope}`, `${capability.family} / ${scope}`, family) : family;
    memberships.push({ resourceId: capability.id, boundaryId: parent });
  }
  const relations: Relation[] = design.relations.map(relation => ({
    from: relation.from, to: relation.to,
    kind: relation.kind === 'dependsOn' ? 'order' : 'communicatesWith',
    ...(relation.details && { details: relation.details }),
    ...(relation.label === undefined ? {} : { label: relation.label }),
  }));
  return compileGraph({
    name: design.name,
    resources: design.capabilities.map(capability => ({ id: capability.id, provider: capability.kind, spec: {} })),
    boundaries, memberships, relations,
  });
}

/** Inspect an unbound system without selecting technologies or executing providers. */
export function systemToMermaid(design: SystemDesign, options: GraphViewOptions = {}): string {
  return `%% Intent only; source system design ${validateSystemDesign(design).digest}\n`
    + graphToMermaid(viewGraph(design), { ...options, view: options.view ?? 'architecture', boundaryKind: options.boundaryKind ?? 'group' });
}

/** Standalone view of conceptual capabilities; this SVG is not a deployment artifact. */
export function systemToSvg(design: SystemDesign, options: GraphViewOptions = {}): string {
  const source = validateSystemDesign(design);
  return graphToSvg(viewGraph(source), { ...options, view: options.view ?? 'architecture', boundaryKind: options.boundaryKind ?? 'group' })
    .replace('<desc id="desc">', `<desc id="desc">Unbound system intent ${source.digest}; no implementation technologies have been selected. `);
}

import type { BoundaryKind, InfraGraph } from './types.ts';
import { validateInfraGraph } from './validation.ts';

export interface GraphViewOptions {
  view?: 'deployment' | 'architecture';
  boundaryKind?: BoundaryKind;
}

function label(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]/g, ' ');
}

/** Render a projection of the validated graph; visualization never creates dependency edges. */
export function graphToMermaid(input: InfraGraph, options: GraphViewOptions = {}): string {
  const graph = validateInfraGraph(input);
  const resources = [...graph.resources].sort((a, b) => a.id.localeCompare(b.id));
  const boundaries = graph.boundaries.filter(b => b.kind === options.boundaryKind).sort((a, b) => a.id.localeCompare(b.id));
  const resourceIds = new Map(resources.map((r, index) => [r.id, `r${index}`]));
  const boundaryIds = new Map(boundaries.map((b, index) => [b.id, `b${index}`]));
  const groups = new Map<string, string[]>();
  const extraMemberships: Array<{ resource: string; boundary: string }> = [];
  const depth = (id: string): number => {
    const parent = boundaries.find(b => b.id === id)?.parent;
    return parent && boundaryIds.has(parent) ? 1 + depth(parent) : 0;
  };
  for (const resource of resources) {
    const memberships = graph.memberships.filter(m => m.resourceId === resource.id && boundaryIds.has(m.boundaryId))
      .map(m => m.boundaryId).sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
    const primary = memberships[0] ?? '';
    groups.set(primary, [...(groups.get(primary) ?? []), resource.id]);
    for (const boundary of memberships.slice(1)) extraMemberships.push({ resource: resource.id, boundary });
  }
  const lines = ['flowchart LR'];
  const node = (id: string, indent: string) => {
    const resource = resources.find(r => r.id === id)!;
    lines.push(`${indent}${resourceIds.get(id)}["${label(resource.id)} (${label(resource.provider)})"]`);
  };
  const group = (id: string, indent: string) => {
    const boundary = boundaries.find(b => b.id === id)!;
    lines.push(`${indent}subgraph ${boundaryIds.get(id)}["${label(boundary.kind)}: ${label(boundary.label ?? id)}"]`);
    for (const resource of groups.get(id) ?? []) node(resource, `${indent}  `);
    for (const child of boundaries.filter(b => b.parent === id)) group(child.id, `${indent}  `);
    if (!(groups.get(id)?.length) && !boundaries.some(b => b.parent === id)) {
      const note = graph.memberships.some(member => member.boundaryId === id) ? 'Membership via dashed links' : 'No members declared';
      lines.push(`${indent}  ${boundaryIds.get(id)}_empty["${note}"]`);
    }
    lines.push(`${indent}end`);
  };
  for (const boundary of boundaries.filter(b => !b.parent || !boundaryIds.has(b.parent))) group(boundary.id, '  ');
  for (const id of groups.get('') ?? []) node(id, '  ');
  const relations = graph.relations.filter(r => options.view === 'architecture' || r.kind === 'order' || r.kind === 'data');
  for (const relation of relations) {
    const style = relation.kind === 'order' || relation.kind === 'data' ? '-->' : '-.->';
    lines.push(`  ${resourceIds.get(relation.from)} ${style}|"${label(relation.label ?? relation.kind)}"| ${resourceIds.get(relation.to)}`);
  }
  for (const membership of extraMemberships) {
    lines.push(`  ${resourceIds.get(membership.resource)} -.->|"also member of"| ${boundaryIds.get(membership.boundary)}`);
  }
  return `${lines.join('\n')}\n`;
}

import { identifierLines } from './svg-label.ts';
import { orderResources } from '../planner.ts';
import type { InfraGraph } from './types.ts';
import type { GraphViewOptions } from './render.ts';
import { validateInfraGraph } from './validation.ts';

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** Standalone SVG. Stable resource addresses connect this view to plans and recordings. */
export function graphToSvg(input: InfraGraph, options: GraphViewOptions = {}): string {
  const graph = validateInfraGraph(input);
  const sorted = [...graph.resources].sort((a, b) => a.id.localeCompare(b.id));
  const ranks = new Map<string, number>();
  for (const resource of orderResources(graph.resources)) {
    ranks.set(resource.id, Math.max(-1, ...(resource.dependsOn ?? []).map(id => ranks.get(id)!)) + 1);
  }
  const boundaries = graph.boundaries.filter(b => b.kind === options.boundaryKind).sort((a, b) => a.id.localeCompare(b.id));
  const grouped = new Map<string, typeof sorted>();
  for (const resource of sorted) {
    const memberships = graph.memberships.filter(m => m.resourceId === resource.id && boundaries.some(b => b.id === m.boundaryId));
    const primary = memberships.map(m => m.boundaryId).sort()[0] ?? '';
    grouped.set(primary, [...(grouped.get(primary) ?? []), resource]);
  }
  const width = Math.max(760, (Math.max(0, ...ranks.values()) + 1) * 280 + 80);
  let cursor = 90;
  const points = new Map<string, { x: number; y: number }>();
  const boxes: string[] = [];
  const nodes: string[] = [];
  for (const group of [...grouped.keys()].sort()) {
    const members = grouped.get(group)!;
    const top = cursor;
    if (group) cursor += 34;
    for (const resource of members) {
      const x = 50 + ranks.get(resource.id)! * 280;
      const y = cursor;
      points.set(resource.id, { x, y });
      const membershipNames = graph.memberships.filter(m => m.resourceId === resource.id)
        .map(m => `${graph.boundaries.find(b => b.id === m.boundaryId)!.kind}: ${m.boundaryId}`).sort();
      const extra = graph.memberships.filter(m => m.resourceId === resource.id && m.boundaryId !== group && boundaries.some(b => b.id === m.boundaryId))
        .map(m => m.boundaryId).sort();
      const extraLabel = extra.length ? `also: ${extra[0]}${extra.length > 1 ? ` (+${extra.length - 1})` : ''}` : '';
      const names = identifierLines(resource.id);
      const providers = identifierLines(resource.provider);
      const providerTop = 46 + (names.length - 1) * 18;
      const height = Math.max(72, providerTop + (providers.length - 1) * 16 + (extraLabel ? 15 : 0) + 14);
      const nameText = names.map((line, index) => `<text x="${x + 12}" y="${y + 26 + index * 18}" font-family="ui-monospace, Menlo, monospace" font-size="14" font-weight="600">${escape(line)}</text>`).join('');
      const providerText = providers.map((line, index) => `<text x="${x + 12}" y="${y + providerTop + index * 16}" font-family="ui-monospace, Menlo, monospace" fill="#64748b" font-size="12">${escape(line)}</text>`).join('');
      nodes.push(`<g><title>${escape([resource.id, ...membershipNames].join('\n'))}</title>`
        + `<rect x="${x}" y="${y}" width="220" height="${height}" rx="10" fill="#ffffff" stroke="#64748b"/>`
        + nameText + providerText
        + (extraLabel ? `<text x="${x + 12}" y="${y + height - 10}" fill="#475569" font-size="10">${escape(extraLabel)}</text>` : '') + '</g>');
      cursor += height + 40;
    }
    if (group) {
      const boundary = boundaries.find(b => b.id === group)!;
      boxes.push(`<rect x="22" y="${top - 8}" width="${width - 44}" height="${cursor - top - 16}" rx="14" fill="#eaf2ff" stroke="#b1c8ea"/>`
        + `<text x="38" y="${top + 15}" fill="#334155" font-size="13">${escape(`${boundary.kind}: ${boundary.label ?? group}`)}</text>`);
    }
    cursor += 22;
  }
  const edges: string[] = [];
  for (const relation of graph.relations.filter(r => options.view === 'architecture' || r.kind === 'order' || r.kind === 'data')) {
    const source = points.get(relation.from)!;
    const target = points.get(relation.to)!;
    const y1 = source.y + 36, y2 = target.y + 36;
    const sameColumn = source.x === target.x;
    const forward = source.x < target.x;
    const x1 = source.x + (forward || sameColumn ? 220 : 0);
    const x2 = target.x + (forward ? 0 : 220);
    const middle = (x1 + x2) / 2;
    const c1 = sameColumn ? x1 + 55 : middle;
    const c2 = sameColumn ? x2 + 55 : middle;
    const dashed = relation.kind !== 'order' && relation.kind !== 'data';
    edges.push(`<path d="M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}" fill="none" stroke="${dashed ? '#7c3aed' : '#64748b'}"${dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#arrow)"><title>${escape(relation.label ?? relation.kind)}</title></path>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${Math.max(cursor, 220)}" role="img" aria-labelledby="title desc">\n`
    + `<title id="title">${escape(graph.name)} — ${options.view ?? 'deployment'}</title>`
    + `<desc id="desc">Generated from infra graph ${escape(graph.digest)}. Solid edges are deployment dependencies; dashed edges are architectural relations. Grouping describes declared membership and does not establish enforcement. Hover a resource for all memberships. Multiple memberships in one dimension use the first sorted boundary for placement in this SVG view.</desc>`
    + '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#64748b"/></marker></defs>'
    + `<rect width="100%" height="100%" fill="#f8fafc"/><g font-family="system-ui, sans-serif" font-size="15">`
    + `<text x="28" y="32" font-size="22" font-weight="650">${escape(graph.name)}</text>`
    + `<text x="28" y="55" font-size="12" fill="#64748b">${escape(options.view ?? 'deployment')} · ${escape(options.boundaryKind ?? 'all resources')} · declared boundaries</text>`
    + boxes.join('') + edges.join('') + nodes.join('') + '</g></svg>\n';
}

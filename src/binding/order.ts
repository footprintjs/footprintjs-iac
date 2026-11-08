import type { Capability, SystemDesign } from '../system/types.ts';

export function orderCapabilities(design: SystemDesign): Capability[] {
  const ordered: Capability[] = [];
  const seen = new Set<string>(), active = new Set<string>();
  const byId = new Map(design.capabilities.map(entry => [entry.id, entry]));
  function visit(id: string) {
    if (seen.has(id)) return;
    if (active.has(id)) throw new Error('Capability dependency cycle: ' + id);
    const capability = byId.get(id);
    if (!capability) throw new Error('Unknown capability dependency: ' + id);
    active.add(id);
    for (const edge of design.relations.filter(edge => edge.kind === 'dependsOn' && edge.to === id).sort((a, b) => a.from.localeCompare(b.from))) visit(edge.from);
    active.delete(id);
    seen.add(id);
    ordered.push(capability);
  }
  for (const entry of [...design.capabilities].sort((a, b) => a.id.localeCompare(b.id))) visit(entry.id);
  return ordered;
}

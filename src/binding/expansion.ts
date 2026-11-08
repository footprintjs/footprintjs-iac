import { compileGraph } from '../graph/compile.ts';
import type { Boundary, Membership, Relation } from '../graph/types.ts';
import type { Capability, SystemDesign } from '../system/types.ts';
import type { BindingDecision, CapabilityMapping } from './types.ts';
import type { ExpandedCapability } from './lowering.ts';

export function compositionGroup(capability: Capability, mapping: CapabilityMapping, decision: BindingDecision, designDigest: string): Boundary {
  return {
    id: mapping.groupId, kind: 'group', label: capability.path,
    attributes: {
      origin: 'capability', designDigest, capabilityId: capability.id, capabilityPath: capability.path,
      capabilityFamily: capability.family, capabilityKind: capability.kind, adapterId: mapping.adapterId,
      targetId: mapping.targetId, mode: mapping.mode,
      decisionStatus: mapping.mode === 'simulation' ? 'simulated' : 'declared',
      support: mapping.mode === 'simulation' ? 'simulated declarations; no live guarantee' : 'adapter implementation claims; not observed verification',
      declaredProperties: capability.properties, defaults: capability.defaults,
      ruleId: decision.ruleId,
    },
  };
}

export function expandGraph(design: SystemDesign, expanded: ExpandedCapability[], decisions: BindingDecision[]) {
  const byCapability = new Map(expanded.map(entry => [entry.mapping.capabilityId, entry]));
  const boundaries = [...design.boundaries];
  const memberships: Membership[] = [];
  const relations: Relation[] = expanded.flatMap(entry => entry.relations);
  const dedupe = new Map(relations.map(edge => [JSON.stringify([edge.from, edge.to, edge.kind]), edge]));
  for (const capability of design.capabilities) {
    const entry = byCapability.get(capability.id)!;
    if (boundaries.some(boundary => boundary.id === entry.mapping.groupId)) throw new Error('Composition group collides with a declared boundary');
    boundaries.push(compositionGroup(capability, entry.mapping, decisions.find(decision => decision.capabilityId === capability.id)!, design.digest));
    for (const id of entry.mapping.resourceIds) memberships.push({ resourceId: id, boundaryId: entry.mapping.groupId });
  }
  for (const membership of design.memberships) {
    for (const id of byCapability.get(membership.capabilityId)!.mapping.resourceIds) {
      memberships.push({ resourceId: id, boundaryId: membership.boundaryId });
    }
  }
  for (const edge of design.relations) {
    const source = byCapability.get(edge.from)!.mapping;
    const target = byCapability.get(edge.to)!.mapping;
    // Ordering enters setup; architecture names logical terminals, not observed packet flow.
    const destinations = edge.kind === 'dependsOn' ? target.entryPoints : target.exitPoints;
    for (const from of source.exitPoints) for (const to of destinations) {
      const relation: Relation = { from, to, kind: edge.kind === 'dependsOn' ? 'order' : 'communicatesWith', ...(edge.label === undefined ? {} : { label: edge.label }) };
      const key = JSON.stringify([from, to, relation.kind]);
      const previous = dedupe.get(key);
      if (previous && previous.label !== relation.label) throw new Error('Conflicting expanded relation labels');
      dedupe.set(key, relation);
    }
  }
  return compileGraph({
    name: design.name, resources: expanded.flatMap(entry => entry.resources),
    boundaries, memberships, relations: [...dedupe.values()],
  });
}

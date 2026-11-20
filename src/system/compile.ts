import type { Boundary } from '../graph/types.ts';
import { freeze } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import { systemBody } from './shape.ts';
import { inferredRelations, relationKey, resolveCapability } from './relations.ts';
import type { Capability, CapabilityMembership, CapabilityReference, CapabilityRelation, Principal, SystemDesign } from './types.ts';

export interface PendingMembership { boundaryId: string; reference: CapabilityReference }
export interface PendingRelation { from: CapabilityReference; to: CapabilityReference; kind: CapabilityRelation['kind']; label?: string; details?: CapabilityRelation['details'] }
export interface SystemDeclaration {
  name: string; capabilities: Capability[]; principals: Principal[]; boundaries: Boundary[];
  memberships: PendingMembership[]; relations: PendingRelation[];
}
export function compileSystem(input: SystemDeclaration): SystemDesign {
  const memberships: CapabilityMembership[] = input.memberships.map(member => ({
    boundaryId: member.boundaryId, capabilityId: resolveCapability(member.reference, input.capabilities).id,
  }));
  const relations = inferredRelations(input.capabilities, input.principals);
  for (const relation of input.relations) {
    const resolved: CapabilityRelation = {
      from: resolveCapability(relation.from, input.capabilities).id,
      to: resolveCapability(relation.to, input.capabilities).id, kind: relation.kind,
      ...(relation.details && { details: relation.details }),
      ...(relation.label === undefined ? {} : { label: relation.label }),
    };
    const inferred = relations.find(existing => relationKey(existing) === relationKey(resolved));
    if (!inferred) relations.push(resolved);
    else if (resolved.details) Object.assign(inferred, resolved);
  }
  const body = systemBody({
    kind: 'system-design', version: 1, name: input.name, capabilities: input.capabilities,
    principals: input.principals, boundaries: input.boundaries, memberships, relations,
  });
  return freeze({ ...body, digest: fingerprint(body) });
}

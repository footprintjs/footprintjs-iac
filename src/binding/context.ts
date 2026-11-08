import { freeze, identifier } from '../graph/data.ts';
import type { Capability, Principal, SystemDesign } from '../system/types.ts';
import { fingerprint } from '../util.ts';
import type { BindingProfile, CapabilityMapping, LoweringContext, SupportContext } from './types.ts';
import { jsonObject } from './data.ts';

function reference(input: unknown): { kind: string; path: string } {
  const row = jsonObject(input, 'capability reference');
  const kind = String(row.kind);
  if (!['network', 'store', 'service', 'principal'].includes(kind) || typeof row.path !== 'string') throw new Error('Invalid capability reference');
  return { kind, path: row.path };
}
export function capabilityFor(design: SystemDesign, input: unknown): Capability {
  const ref = reference(input);
  const entry = design.capabilities.find(capability => capability.path === ref.path);
  const expected = ref.kind === 'network' ? 'network' : ref.kind === 'store' ? 'storage' : 'compute';
  if (!entry || entry.family !== expected || (ref.kind === 'service' && entry.kind !== 'service')) throw new Error('Unknown or mismatched capability reference: ' + ref.path);
  return entry;
}
export function supportContext(design: SystemDesign, profile: BindingProfile): SupportContext {
  return freeze({
    profileId: profile.id, target: profile.target,
    artifact(input: unknown) {
      const row = jsonObject(input, 'artifact reference');
      if (row.kind !== 'artifact' || typeof row.id !== 'string') throw new Error('Invalid artifact reference');
      const spec = profile.artifacts[row.id];
      if (!spec) throw new Error('Missing artifact mapping: ' + row.id);
      return spec;
    },
    principal(input: unknown): Principal {
      const ref = reference(input);
      const principal = design.principals.find(entry => entry.path === ref.path);
      if (ref.kind !== 'principal' || !principal) throw new Error('Unknown principal reference: ' + ref.path);
      return principal;
    },
  });
}
export function loweringContext(
  capability: Capability, design: SystemDesign, profile: BindingProfile,
  mappings: ReadonlyMap<string, CapabilityMapping>,
): { context: LoweringContext; allocated: Set<string> } {
  const allocated = new Set<string>();
  const context: LoweringContext = {
    ...supportContext(design, profile),
    resourceId(suffix = 'main') {
      identifier(suffix, 'resource suffix');
      const value = 'cap-' + capability.id.slice(0, 80) + '-' + fingerprint({ target: profile.target, capabilityId: capability.id, suffix }).slice(0, 20);
      allocated.add(value);
      return value;
    },
    mapping(input: unknown) {
      const entry = capabilityFor(design, input);
      const mapping = mappings.get(entry.id);
      if (!mapping) throw new Error('Capability must be lowered before reference use: ' + entry.path);
      return freeze(structuredClone(mapping));
    },
  };
  return { context: freeze(context), allocated };
}

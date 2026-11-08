import type { Capability } from '../system/types.ts';
import { canonical } from '../util.ts';
import type { BindingProfile, BindingRule, CapabilityAdapter, SelectionCandidate } from './types.ts';

export interface Selection { rule: BindingRule; adapter: CapabilityAdapter; candidates: SelectionCandidate[] }

export function selectAdapter(capability: Capability, profile: BindingProfile): Selection {
  const candidates = profile.rules.map(rule => {
    const mismatches: string[] = [];
    if (rule.family !== capability.family) mismatches.push('family differs');
    if (rule.kind !== undefined && rule.kind !== capability.kind) mismatches.push('kind differs');
    for (const [key, expected] of Object.entries(rule.properties ?? {})) {
      if (!Object.hasOwn(capability.properties, key) || canonical(capability.properties[key]) !== canonical(expected)) mismatches.push('property differs: ' + key);
    }
    return { ruleId: rule.id, matched: mismatches.length === 0, reason: mismatches.length ? mismatches.join('; ') : 'Family, kind and exact property conditions matched' };
  });
  const matched = candidates.filter(candidate => candidate.matched);
  if (matched.length === 0) throw new Error('No binding rule matched capability ' + capability.id);
  if (matched.length > 1) throw new Error('Ambiguous binding for ' + capability.id + ': ' + matched.map(candidate => candidate.ruleId).join(', '));
  const rule = profile.rules.find(candidate => candidate.id === matched[0]!.ruleId)!;
  return { rule, adapter: profile.adapters.find(candidate => candidate.id === rule.adapterId)!, candidates };
}

import { identifier, keys, object } from '../graph/data.ts';
import type { Capability } from '../system/types.ts';
import { canonical } from '../util.ts';
import type { CapabilityAdapter, RequirementSupport, SupportAssessment } from './types.ts';
import { list, reason } from './data.ts';

export function readSupport(input: unknown, capability: Capability, adapter: CapabilityAdapter): SupportAssessment {
  const row = object(input as never, 'adapter support assessment');
  keys(row, ['supported', 'reason', 'unsupportedRequirements', 'requirements'], 'support assessment');
  if (typeof row.supported !== 'boolean') throw new Error('Support assessment must explicitly state supported');
  const unsupportedRequirements = list(row.unsupportedRequirements, 'unsupported requirements').map(value => reason(value, 'unsupported requirement'));
  if (new Set(unsupportedRequirements).size !== unsupportedRequirements.length) throw new Error('Duplicate unsupported requirement');
  const requirements = list(row.requirements, 'requirement support').map(value => {
    const requirement = object(value as never, 'requirement support');
    keys(requirement, ['property', 'requested', 'status', 'reason'], 'requirement support');
    const property = identifier(requirement.property, 'supported property');
    if (requirement.status !== 'simulated' && requirement.status !== 'implemented') throw new Error('Requirement support is a claim, not verified evidence');
    if ((adapter.mode === 'simulation') !== (requirement.status === 'simulated')) throw new Error('Requirement support status disagrees with adapter mode');
    if (!Object.hasOwn(capability.properties, property) || canonical(requirement.requested) !== canonical(capability.properties[property])) throw new Error('Support claim differs from declared property: ' + property);
    return { property, requested: requirement.requested!, status: requirement.status, reason: reason(requirement.reason, 'requirement reason') } satisfies RequirementSupport;
  }).sort((a, b) => a.property.localeCompare(b.property));
  if (new Set(requirements.map(requirement => requirement.property)).size !== requirements.length) throw new Error('Duplicate requirement support claim');
  const explanation = reason(row.reason, 'support reason');
  if (!row.supported || unsupportedRequirements.length) throw new Error('Unsupported capability ' + capability.id + ': ' + explanation + (unsupportedRequirements.length ? ' [' + unsupportedRequirements.join(', ') + ']' : ''));
  for (const key of Object.keys(capability.properties)) {
    if (!requirements.some(requirement => requirement.property === key)) throw new Error('Adapter silently omitted required property ' + capability.id + '.' + key);
  }
  return { supported: true, reason: explanation, requirements, unsupportedRequirements: [] };
}

import { freeze, identifier } from '../graph/data.ts';
import type { Capability } from '../system/types.ts';
import type { BindingProfile, BindingRule, CapabilityAdapter } from './types.ts';
import { jsonObject, slots, synchronousCallback } from './data.ts';

const families: Record<Capability['family'], readonly Capability['kind'][]> = {
  compute: ['service', 'job', 'scheduled-task'], storage: ['store'], network: ['segment', 'endpoint'],
};

export function readProfile(input: BindingProfile): BindingProfile {
  const profile = slots(input, ['id', 'target', 'rules', 'adapters', 'artifacts'], 'binding profile');
  const id = identifier(profile.id, 'profile id');
  const target = slots(profile.target, ['id', 'properties'], 'binding target');
  const normalizedTarget = {
    id: identifier(target.id, 'target id'),
    properties: target.properties === undefined ? {} : jsonObject(target.properties, 'target properties'),
  };
  // Callback arrays cannot go through JSON copying. Reject accessor elements before reading them.
  function arrayValues(value: unknown, name: string): unknown[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) throw new Error('Invalid ' + name);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) throw new Error('Invalid ' + name);
    return Array.from({ length: value.length }, (_, index) => {
      const entry = descriptors[String(index)];
      if (!entry || !('value' in entry) || !entry.enumerable) throw new Error(name + ' cannot have accessors or holes');
      return entry.value;
    });
  }
  const adapters = arrayValues(profile.adapters, 'profile adapters').map(value => {
    const adapter = slots(value, ['id', 'mode', 'supports', 'lower'], 'capability adapter');
    if (adapter.mode !== 'simulation' && adapter.mode !== 'real') throw new Error('Invalid adapter mode');
    return {
      id: identifier(adapter.id, 'adapter id'), mode: adapter.mode,
      supports: synchronousCallback(adapter.supports, 'adapter supports'),
      lower: synchronousCallback(adapter.lower, 'adapter lower'),
    } as CapabilityAdapter;
  });
  if (new Set(adapters.map(adapter => adapter.id)).size !== adapters.length) throw new Error('Duplicate capability adapter id');
  const rules = arrayValues(profile.rules, 'profile rules').map(value => {
    const rule = slots(value, ['id', 'family', 'kind', 'properties', 'adapterId'], 'binding rule');
    const family = rule.family as Capability['family'];
    if (!Object.hasOwn(families, family)) throw new Error('Invalid rule family');
    if (rule.kind !== undefined && !families[family].includes(rule.kind as Capability['kind'])) throw new Error('Rule kind does not belong to its family');
    const adapterId = identifier(rule.adapterId, 'rule adapter id');
    if (!adapters.some(adapter => adapter.id === adapterId)) throw new Error('Unknown rule adapter: ' + adapterId);
    return {
      id: identifier(rule.id, 'rule id'), family, adapterId,
      ...(rule.kind === undefined ? {} : { kind: rule.kind as Capability['kind'] }),
      ...(rule.properties === undefined ? {} : { properties: jsonObject(rule.properties, 'rule properties') }),
    } satisfies BindingRule;
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('Duplicate binding rule id');
  const artifacts = jsonObject(profile.artifacts, 'profile artifacts');
  for (const [key, value] of Object.entries(artifacts)) {
    identifier(key, 'artifact id');
    artifacts[key] = jsonObject(value, 'artifact spec');
  }
  return freeze({ id, target: normalizedTarget, rules, adapters, artifacts }) as BindingProfile;
}

import { array, freeze, identifier, keys, object } from '../graph/data.ts';
import { exactValue, exactValues, plainRecord } from './values.ts';
import type { AccessDecision, AccessPolicy, AccessRequest, AccessRule, IdentitySubject } from './types.ts';

export function readIdentitySubject(input: unknown): IdentitySubject {
  const value = plainRecord(input, 'identity subject'); keys(value, ['id', 'source', 'groups'], 'identity subject');
  return freeze({ id: exactValue(value.id, 'subject id'), source: identifier(value.source, 'identity source'),
    groups: exactValues(value.groups, 'subject groups', true) });
}
export function defineAccessPolicy(input: AccessPolicy): AccessPolicy {
  const value = plainRecord(input, 'access policy'); keys(value, ['id', 'rules'], 'access policy');
  const id = identifier(value.id, 'policy id');
  const rawRules = array(value.rules, 'access rules');
  if (rawRules.length > 256) throw new Error('Too many access rules');
  const rules: AccessRule[] = rawRules.map(inputRule => {
    const rule = object(inputRule, 'access rule');
    keys(rule, ['id', 'effect', 'source', 'subjects', 'groups', 'actions', 'resources'], 'access rule');
    if (rule.effect !== 'allow' && rule.effect !== 'deny') throw new Error('Access rule effect must be allow or deny');
    const subjects = rule.subjects === undefined ? undefined : exactValues(rule.subjects, 'rule subjects');
    const groups = rule.groups === undefined ? undefined : exactValues(rule.groups, 'rule groups');
    if (!subjects && !groups) throw new Error('An access rule requires exact subjects or groups');
    return { id: identifier(rule.id, 'rule id'), effect: rule.effect, source: identifier(rule.source, 'rule source'),
      ...(subjects ? { subjects } : {}), ...(groups ? { groups } : {}),
      actions: exactValues(rule.actions, 'rule actions'), resources: exactValues(rule.resources, 'rule resources') };
  });
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('Duplicate access rule id');
  return freeze({ id, rules });
}

/** Match source AND (subject OR group) AND action AND resource. Explicit deny always precedes allow. */
export function evaluateAccess(policyInput: AccessPolicy, subjectInput: IdentitySubject, requestInput: AccessRequest): AccessDecision {
  const policy = defineAccessPolicy(policyInput), subject = readIdentitySubject(subjectInput);
  const request = plainRecord(requestInput, 'access request'); keys(request, ['action', 'resource'], 'access request');
  const action = exactValue(request.action, 'access action'), resource = exactValue(request.resource, 'access resource');
  const matches = policy.rules.filter(rule => rule.source === subject.source
    && (rule.subjects?.includes(subject.id) || rule.groups?.some(group => subject.groups.includes(group)))
    && rule.actions.includes(action) && rule.resources.includes(resource));
  const denied = matches.filter(rule => rule.effect === 'deny');
  const allowed = matches.filter(rule => rule.effect === 'allow');
  return freeze(denied.length ? { effect: 'denied', policyId: policy.id, matchedRuleIds: denied.map(rule => rule.id), reason: 'explicit-deny' }
    : allowed.length ? { effect: 'allowed', policyId: policy.id, matchedRuleIds: allowed.map(rule => rule.id), reason: 'matching-allow' }
      : { effect: 'denied', policyId: policy.id, matchedRuleIds: [], reason: 'default-deny' });
}

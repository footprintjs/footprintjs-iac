import assert from 'node:assert/strict';
import test from 'node:test';
import { defineAccessPolicy, defineIdentitySource, evaluateAccess, readIdentitySubject, type AccessPolicy } from '../src/identity/index.ts';

const subject = { id: 'rahul', source: 'neo-directory', groups: ['neo-readers'] };
const request = { action: 'chat.read', resource: 'neo/conversations' };
const allow = { id: 'readers', effect: 'allow' as const, source: 'neo-directory', groups: ['neo-readers'], actions: ['chat.read'], resources: ['neo/conversations'] };

test('policies match exact source, subject/group, action and resource, with default deny', () => {
  const policy = defineAccessPolicy({ id: 'neo-access', rules: [allow] });
  assert.deepEqual(evaluateAccess(policy, subject, request), { effect: 'allowed', policyId: 'neo-access', matchedRuleIds: ['readers'], reason: 'matching-allow' });
  for (const [actor, operation] of [
    [{ ...subject, source: 'untrusted-directory' }, request],
    [{ ...subject, groups: ['neo-reader'] }, request],
    [subject, { ...request, action: 'chat.write' }],
    [subject, { ...request, resource: 'neo/conversations/foreign' }],
  ] as const) assert.equal(evaluateAccess(policy, actor, operation).reason, 'default-deny');
  assert.equal(evaluateAccess({ id: 'deny-all', rules: [] }, subject, request).effect, 'denied');
  const { groups: _groups, ...directRule } = allow;
  const direct = defineAccessPolicy({ id: 'specific-person', rules: [{ ...directRule, subjects: ['rahul'] }] });
  assert.equal(evaluateAccess(direct, { ...subject, groups: [] }, request).effect, 'allowed');
});

test('explicit deny wins regardless of declaration order and states the matching deny rules', () => {
  const deny = { ...allow, id: 'suspended', effect: 'deny' as const, groups: ['suspended'] };
  for (const rules of [[allow, deny], [deny, allow]]) {
    const decision = evaluateAccess({ id: 'neo', rules }, { ...subject, groups: ['neo-readers', 'suspended'] }, request);
    assert.deepEqual(decision, { effect: 'denied', policyId: 'neo', matchedRuleIds: ['suspended'], reason: 'explicit-deny' });
  }
});

test('policy admission rejects wildcards, ambiguous values, empty actors, unknown fields and duplicate rules', () => {
  const invalid = [
    { id: 'neo', rules: [{ ...allow, actions: ['*'] }] },
    { id: 'neo', rules: [{ ...allow, resources: ['neo/?'] }] },
    { id: 'neo', rules: [{ ...allow, groups: [' neo-readers'] }] },
    { id: 'neo', rules: [{ ...allow, groups: [] }] },
    { id: 'neo', rules: [{ ...allow, groups: undefined }] },
    { id: 'neo', rules: [{ ...allow, permission: true }] },
    { id: 'neo', rules: [allow, allow] },
    { id: 'neo', rules: [{ ...allow, source: undefined }] },
    { id: 'neo', rules: [{ ...allow, actions: ['chat.read', 'chat.read'] }] },
  ];
  for (const value of invalid) assert.throws(() => defineAccessPolicy(value as unknown as AccessPolicy));
  let reads = 0;
  assert.throws(() => defineAccessPolicy({ id: 'neo', get rules() { reads++; return []; } }), /accessors/);
  assert.equal(reads, 0);
  assert.throws(() => readIdentitySubject({ ...subject, groups: ['neo-readers', 'neo-readers'] }), /duplicate/);
  assert.throws(() => readIdentitySubject({ ...subject, token: 'secret' }), /Unknown/);
});

test('declarations are detached and frozen; directories default to external ownership', () => {
  const raw = { id: 'neo', rules: [{ ...allow, groups: ['neo-readers'] }] };
  const policy = defineAccessPolicy(raw); raw.rules[0]!.groups.push('everyone');
  assert.deepEqual(policy.rules[0]!.groups, ['neo-readers']);
  assert.ok(Object.isFrozen(policy.rules[0]!.groups));
  assert.deepEqual(defineIdentitySource({ id: 'company-directory', kind: 'directory' }), { id: 'company-directory', kind: 'directory', ownership: 'external' });
  assert.equal(defineIdentitySource({ id: 'test-directory', kind: 'directory', ownership: 'managed' }).ownership, 'managed');
  assert.throws(() => defineIdentitySource({ id: 'company-directory', kind: 'directory', password: 'secret' } as never), /Unknown/);
});

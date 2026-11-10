import { jsonCopy } from '../graph/data.ts';
import { evaluateAccess } from './policy.ts';
import type { AuthorizationStage } from './authorization-scope.ts';
import type { AccessDecision, AccessPolicy, AccessRequest, IdentitySubject } from './types.ts';

export function loadAuthorizationStage(policy: AccessPolicy, subject: IdentitySubject, request: AccessRequest): AuthorizationStage {
  return scope => {
    scope.setValue('policy', jsonCopy(policy)); scope.setValue('subject', jsonCopy(subject));
    scope.setValue('action', request.action); scope.setValue('resource', request.resource);
  };
}
export const evaluateAuthorizationStage: AuthorizationStage = scope => {
  const policy = scope.getValue('policy') as AccessPolicy;
  const subject = scope.getValue('subject') as IdentitySubject;
  const action = scope.getValue('action') as string;
  const resource = scope.getValue('resource') as string;
  const decision = evaluateAccess(policy, subject, { action, resource });
  scope.setValue('decision', jsonCopy(decision));
  scope.setValue('accessAllowed', (scope.getValue('decision') as AccessDecision).effect === 'allowed');
};
export function authorizationOutcomeStage(effect: AccessDecision['effect']): AuthorizationStage {
  return scope => {
    const decision = scope.getValue('decision') as AccessDecision;
    if (decision.effect !== effect) throw new Error('Authorization decision does not match the recorded branch');
    scope.setValue('outcome', jsonCopy(decision));
    scope.emitEvent('iac.authorization.decision', decision);
  };
}

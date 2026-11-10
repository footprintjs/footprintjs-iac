import { decide, flowChart } from 'footprintjs';
import { AuthorizationScope, authorizationScopeFactory } from './authorization-scope.ts';
import { authorizationOutcomeStage, evaluateAuthorizationStage, loadAuthorizationStage } from './authorization-stages.ts';
import type { AccessPolicy, AccessRequest, IdentitySubject } from './types.ts';

/** The sole constructor for native permission evaluation; denied is an explicit successful decision. */
export function createAuthorizationChart(policy: AccessPolicy, subject: IdentitySubject, request: AccessRequest) {
  return flowChart<void, AuthorizationScope>('Load verified identity and declared policy', loadAuthorizationStage(policy, subject, request), 'load-authorization')
    .setScopeFactory(authorizationScopeFactory)
    .addFunction('Evaluate exact permission rules', evaluateAuthorizationStage, 'evaluate-authorization')
    .addDeciderFunction('Permission decision', scope => decide(scope, [
      { when: { accessAllowed: { eq: true } }, then: 'access-allowed', label: 'A matching allow exists and no explicit deny applies' },
    ], 'access-denied'), 'authorization-outcome')
    .addFunctionBranch('access-allowed', 'Access allowed', authorizationOutcomeStage('allowed'))
    .addFunctionBranch('access-denied', 'Access denied', authorizationOutcomeStage('denied'))
    .setDefault('access-denied').end().build();
}

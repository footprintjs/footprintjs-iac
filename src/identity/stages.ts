import { freeze, jsonCopy } from '../graph/data.ts';
import { readAccessObservation } from './data.ts';
import type { IdentityScope, IdentityStage } from './scope.ts';
import { IDENTITY_EVENT, type AccessCheckAdapter, type AccessObservation, type IdentityCheckRequest, type IdentityCheckResult } from './types.ts';

function publish(scope: IdentityScope, request: IdentityCheckRequest, runId: string, status: 'checking' | 'passed' | 'failed', result?: IdentityCheckResult): void {
  const payload = { version: 1, runId, checkId: request.id, label: request.label, kind: request.kind, expected: request.expected, status,
    ...(result ? { observation: result.observation } : {}), ...(result?.message ? { message: result.message } : {}) };
  scope.setValue(`progress:${request.id}`, payload); scope.emitEvent(IDENTITY_EVENT, payload);
}
export function loadIdentityStage(stack: string, checks: readonly IdentityCheckRequest[]): IdentityStage {
  return scope => {
    scope.setValue('stack', stack); scope.setValue('activeCheckId', null);
    scope.setValue('expectedCheckIds', checks.map(check => check.id));
    for (const check of checks) scope.setValue(`request:${check.id}`, jsonCopy(check));
  };
}
export function identityCheckingStage(id: string, runId: string): IdentityStage {
  return scope => { void scope.getValue('stack'); publish(scope, scope.getValue(`request:${id}`) as IdentityCheckRequest, runId, 'checking'); };
}
export function observeIdentityStage(id: string, adapter: AccessCheckAdapter): IdentityStage {
  return async scope => {
    const request = freeze(jsonCopy(scope.getValue(`request:${id}`)) as unknown as IdentityCheckRequest);
    void scope.getValue(`progress:${id}`);
    const start = Date.now(); let observation: AccessObservation;
    try {
      const raw = await adapter.check(request);
      try { observation = readAccessObservation(raw); }
      catch { observation = { verdict: 'unavailable', observedAt: Date.now(), latencyMs: Date.now() - start, details: { code: 'invalid-observation' } }; }
    } catch {
      // Provider errors may embed bind passwords, bearer tokens or response bodies. Never capture those exceptions.
      observation = { verdict: 'unavailable', observedAt: Date.now(), latencyMs: Date.now() - start, details: { code: 'adapter-failure' } };
    }
    scope.setValue(`observation:${id}`, jsonCopy(observation));
    const measured = scope.getValue(`observation:${id}`) as AccessObservation;
    const passed = measured.verdict === request.expected;
    const result: IdentityCheckResult = { checkId: id, label: request.label, kind: request.kind, expected: request.expected,
      status: passed ? 'passed' : 'failed', observation: measured,
      ...(!passed ? { message: `Observed ${measured.verdict}; expected ${request.expected}.` } : {}) };
    scope.setValue(`result:${id}`, jsonCopy(result)); scope.setValue('activeCheckId', id);
  };
}
export function identityOutcomeStage(id: string, runId: string, status: 'passed' | 'failed'): IdentityStage {
  return scope => {
    const request = scope.getValue(`request:${id}`) as IdentityCheckRequest;
    const result = scope.getValue(`result:${id}`) as IdentityCheckResult;
    if (result.status !== status) throw new Error('Recorded identity decision differs from its observation');
    publish(scope, request, runId, status, result);
  };
}
export const summarizeIdentityStage: IdentityStage = scope => {
  const checks: Record<string, IdentityCheckResult> = {};
  for (const id of scope.getValue('expectedCheckIds') as string[]) checks[id] = scope.getValue(`result:${id}`) as IdentityCheckResult;
  scope.setValue('checks', jsonCopy(checks));
  scope.setValue('ok', Object.values(checks).every(check => check.status === 'passed'));
};

import { randomUUID } from 'node:crypto';
import { freeze, identifier, keys } from '../graph/data.ts';
import { INTERNAL_CONTROL_RECORDER_ID, runApplyChart } from '../execution/run-apply-chart.ts';
import { createAuthorizationChart } from './create-authorization-chart.ts';
import { defineAccessPolicy, readIdentitySubject } from './policy.ts';
import { exactValue, plainRecord } from './values.ts';
import type { AccessDecision, AuthorizationRunResult, AuthorizeAccessOptions } from './types.ts';

/** Enforce the returned decision at the application boundary; this workflow records how that decision was derived. */
export async function authorizeAccess(options: AuthorizeAccessOptions): Promise<AuthorizationRunResult> {
  const policy = defineAccessPolicy(options.policy), subject = readIdentitySubject(options.subject);
  const stack = identifier(options.stack ?? policy.id, 'authorization stack');
  const request = plainRecord({ action: options.action, resource: options.resource }, 'authorization request');
  keys(request, ['action', 'resource'], 'authorization request');
  const action = exactValue(request.action, 'authorization action'), resource = exactValue(request.resource, 'authorization resource');
  const recorders = [...(options.recorders ?? [])];
  if (new Set(recorders.map(recorder => recorder.id)).size !== recorders.length) throw new Error('Duplicate authorization recorder IDs');
  if (recorders.some(recorder => recorder.id === INTERNAL_CONTROL_RECORDER_ID)) throw new Error('The internal authorization recorder ID is reserved');
  const runId = randomUUID();
  const recorded = await runApplyChart(createAuthorizationChart(policy, subject, { action, resource }), runId, options.traceDirectory, recorders);
  return freeze({ version: 1, stack, runId, decision: recorded.snapshot.sharedState.outcome as AccessDecision, ...recorded });
}

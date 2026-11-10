import { randomUUID } from 'node:crypto';
import { array, freeze, identifier, jsonCopy } from '../graph/data.ts';
import { INTERNAL_CONTROL_RECORDER_ID, runApplyChart } from '../execution/run-apply-chart.ts';
import { createIdentityChart } from './create-identity-chart.ts';
import { readIdentityCheck } from './data.ts';
import { createIdentityRecorder } from './recorder.ts';
import type { IdentityCheckOptions, IdentityCheckResult, IdentityRunResult } from './types.ts';

export async function checkIdentityAccess(options: IdentityCheckOptions): Promise<IdentityRunResult> {
  const stack = identifier(options.stack, 'identity stack');
  const checks = array(jsonCopy(options.checks), 'identity checks').map(readIdentityCheck);
  if (!checks.length || checks.length > 256) throw new Error('Identity verification requires between 1 and 256 checks');
  if (new Set(checks.map(check => check.id)).size !== checks.length) throw new Error('Duplicate identity check id');
  if (!options.adapter || typeof options.adapter.check !== 'function') throw new Error('An identity check adapter is required');
  const recorders = [...(options.recorders ?? [])];
  if (new Set(recorders.map(recorder => recorder.id)).size !== recorders.length) throw new Error('Duplicate identity recorder IDs');
  if (recorders.some(recorder => recorder.id === INTERNAL_CONTROL_RECORDER_ID || recorder.id === 'iac-internal-identity-progress')) throw new Error('The internal identity recorder ID is reserved');
  const runId = randomUUID(), projection = createIdentityRecorder({ id: 'iac-internal-identity-progress' });
  const adapter = Object.freeze({ check: options.adapter.check.bind(options.adapter) });
  const chart = createIdentityChart(stack, Object.freeze(checks), adapter, runId);
  const recorded = await runApplyChart(chart, runId, options.traceDirectory, [projection, ...recorders]);
  return freeze({ version: 1, stack, runId, ok: recorded.snapshot.sharedState.ok === true,
    checks: recorded.snapshot.sharedState.checks as Record<string, IdentityCheckResult>, events: projection.getEvents(), ...recorded });
}

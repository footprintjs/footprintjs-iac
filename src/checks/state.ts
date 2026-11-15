import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { readCheckRequest, readCheckResult } from './data.ts';
import type { CheckExecutionState } from './types.ts';

export function readCheckExecution(input: unknown): CheckExecutionState {
  const value = jsonCopy(input) as unknown as CheckExecutionState;
  if (!value || value.version !== 1 || value.kind !== 'check-execution'
    || Object.keys(value).some(key => !['version','kind','runnerId','request','bindingDigest','status','result','recording'].includes(key))) throw Error('Invalid check execution');
  identifier(value.runnerId, 'check runner'); readCheckRequest(value.request);
  if (!/^[a-f0-9]{64}$/.test(value.bindingDigest) || !['idle','running','passed','failed','incomplete'].includes(value.status)) throw Error('Invalid check execution binding');
  if (value.result) readCheckResult(value.result);
  if (value.recording && (Object.keys(value.recording).some(key => !['runId','evidencePath','tracePath','complete'].includes(key))
    || typeof value.recording.runId !== 'string' || !value.recording.runId || typeof value.recording.complete !== 'boolean'
    || !['evidencePath','tracePath'].every(key => typeof value.recording![key as 'evidencePath'] === 'string' && value.recording![key as 'evidencePath'].length <= 4096))) throw Error('Invalid check recording');
  if (value.status === 'passed' && (value.result?.status !== 'passed' || !value.recording?.complete)) throw Error('Passed checks require a complete native receipt');
  if (value.status === 'failed' && (!value.result || value.result.status === 'passed' || !value.recording?.complete)) throw Error('Failed checks require their measured result and native receipt');
  return freeze(value);
}

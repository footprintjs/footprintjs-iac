import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import { readCheckExecution } from '../checks/state.ts';
import { readCheckRequest } from '../checks/data.ts';
import type { StageCompletion, StageEventReference, TriggerDefinition, TriggerJobState, TriggerSignal } from './types.ts';

function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('Invalid trigger data');
  return value;
}
function digest(input: unknown): void { if (typeof input !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(input)) throw Error('Invalid trigger digest'); }
export function time(input: unknown): number { if (!Number.isSafeInteger(input) || Number(input) < 0) throw Error('Use a finite millisecond timestamp'); return Number(input); }
function target(input: unknown): void {
  const value = object(input, ['id','scope']); identifier(value.id, 'trigger target');
  if (typeof value.scope !== 'string' || !value.scope || value.scope.length > 4096 || /[\x00-\x1f\x7f]/.test(value.scope)) throw Error('Invalid trigger target scope');
}
export function readTriggerDefinition(input: unknown): TriggerDefinition {
  const value = object(input, ['version','id','label','adapterId','kind','configurationDigest','runnerId','suiteId','suiteDigest','stageId','target','overlap','missed','schedule','source']);
  if (value.version !== 1 || !['manual','interval','stage-event'].includes(String(value.kind)) || value.overlap !== 'skip' || !['skip','coalesce'].includes(String(value.missed))) throw Error('Invalid trigger definition');
  for (const key of ['id','adapterId','runnerId','suiteId','stageId']) identifier(value[key], key);
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160 || /[\x00-\x1f\x7f]/.test(value.label)) throw Error('Invalid trigger label');
  digest(value.configurationDigest); digest(value.suiteDigest); target(value.target);
  if (value.kind === 'interval') {
    const schedule = object(value.schedule, ['everyMs','startsAt']);
    if (!Number.isSafeInteger(schedule.everyMs) || Number(schedule.everyMs) < 1 || Number(schedule.everyMs) > 365 * 24 * 60 * 60 * 1000) throw Error('Bound monitoring interval');
    time(schedule.startsAt);
  } else if (value.schedule !== undefined) throw Error('Only interval triggers have a schedule');
  if (value.kind === 'stage-event') {
    const source = object(value.source, ['pipelineId','definitionDigest']); identifier(source.pipelineId, 'pipeline'); digest(source.definitionDigest);
  } else if (value.source !== undefined) throw Error('Only stage event triggers bind a pipeline');
  return freeze(value as unknown as TriggerDefinition);
}
export function readStageEventReference(input: unknown): StageEventReference {
  const value = object(input, ['pipelineId','definitionDigest','executionId','stageId','sequence']);
  for (const key of ['pipelineId','executionId','stageId']) identifier(value[key], key);
  digest(value.definitionDigest);
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) throw Error('Invalid stage event sequence');
  return freeze(value as unknown as StageEventReference);
}
export function readStageCompletion(input: unknown): StageCompletion {
  const value = object(input, ['reference','target','releaseId','releaseDigest','status']);
  readStageEventReference(value.reference); target(value.target); identifier(value.releaseId, 'release'); digest(value.releaseDigest);
  if (value.status !== 'passed') throw Error('Only verified stage completion can trigger checks');
  return freeze(value as unknown as StageCompletion);
}
export function readTriggerSignal(input: unknown): TriggerSignal {
  const value = object(input, ['requestId','event']);
  if (value.requestId !== undefined) identifier(value.requestId, 'trigger request');
  if (value.event !== undefined) readStageEventReference(value.event);
  return freeze(value as unknown as TriggerSignal);
}
export function readTriggerJob(input: unknown): TriggerJobState {
  const value = object(input, ['version','kind','definition','definitionDigest','nextDueAt','invocations']);
  if (value.version !== 1 || value.kind !== 'trigger-job') throw Error('Invalid trigger job');
  readTriggerDefinition(value.definition); digest(value.definitionDigest);
  if (value.nextDueAt !== undefined) time(value.nextDueAt);
  if (!Array.isArray(value.invocations) || value.invocations.length > 10_000) throw Error('Archive full trigger ledgers before further dispatch');
  const ids = new Set<string>(), keys = new Set<string>();
  for (const input of value.invocations) {
    const run = object(input, ['id','dedupeKey','scheduledAt','dispatchedAt','status','lease','request','result']);
    const id = identifier(run.id, 'trigger invocation');
    if (typeof run.dedupeKey !== 'string' || !run.dedupeKey || run.dedupeKey.length > 512 || ids.has(id) || keys.has(run.dedupeKey)) throw Error('Invalid trigger invocation identity');
    ids.add(id); keys.add(run.dedupeKey); time(run.scheduledAt); time(run.dispatchedAt);
    if (!['running','passed','failed','incomplete','skipped'].includes(String(run.status))) throw Error('Invalid trigger outcome');
    if (run.lease !== undefined) { const lease = object(run.lease, ['token','expiresAt']); identifier(lease.token, 'lease'); time(lease.expiresAt); }
    if (run.status === 'running' && !run.lease || run.status !== 'running' && run.lease) throw Error('Invalid trigger lease state');
    if (run.request !== undefined) readCheckRequest(run.request);
    if (run.result !== undefined) readCheckExecution(run.result);
    if (run.status === 'passed' && (run.result as {status?: string} | undefined)?.status !== 'passed') throw Error('A monitor passes only with native check evidence');
  }
  return freeze(value as unknown as TriggerJobState);
}

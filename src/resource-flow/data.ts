import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import type { ConnectionDetails, ConnectionProfileChoice, FlowReceipt, ResourceFlowDefinition, ResourceFlowFailure, ResourceFlowResumeInput, ResourceFlowState, ResourceHandle, VerificationResult } from './types.ts';

function fail(): never { throw Error('Unsupported resource-flow public data'); }
function object(input: unknown, allowed: string[]): Record<string, unknown> {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
  return value;
}
function text(input: unknown, max = 4096): string {
  if (typeof input !== 'string' || !input.length || input.length > max || /[\x00-\x1f\x7f]/.test(input)) fail();
  return input;
}
function digest(input: unknown): void { if (!/^[a-f0-9]{64}$/.test(text(input, 64))) fail(); }
function list(input: unknown, max = 4096): unknown[] { if (!Array.isArray(input) || input.length > max) fail(); return input; }
function optionalText(input: unknown): void { if (input !== undefined) text(input); }
export function readResourceFlowDefinition(input: unknown): ResourceFlowDefinition {
  const value = object(input, ['id', 'resourceId', 'label', 'mode', 'target', 'configurationDigest']); identifier(value.id, 'resource flow ID'); identifier(value.resourceId, 'source resource ID'); text(value.label, 160); digest(value.configurationDigest);
  if (!['create', 'existing'].includes(String(value.mode))) fail();
  const target = object(value.target, ['id', 'scope']); identifier(target.id, 'resource flow target'); text(target.scope);
  return freeze(value as unknown as ResourceFlowDefinition);
}
export function readConnectionProfileChoices(input: unknown): ConnectionProfileChoice[] {
  const ids = new Set<string>();
  const profiles = list(jsonCopy(input), 128).map(item => {
    const value = object(item, ['id', 'label']), id = identifier(value.id, 'connection profile'); text(value.label, 160);
    if (ids.has(id)) fail(); ids.add(id); return value as unknown as ConnectionProfileChoice;
  });
  if (!profiles.length) fail(); return freeze(profiles);
}
export function readFlowReceipt(input: unknown): FlowReceipt {
  const value = object(input, ['id', 'runId', 'evidencePath']); text(value.id, 256); optionalText(value.runId); optionalText(value.evidencePath);
  return freeze(value as unknown as FlowReceipt);
}
export function readResourceFlowFailure(input: unknown): ResourceFlowFailure {
  const value = object(input, ['stageId', 'code', 'receipt']);
  if (!['acquire', 'details', 'connect', 'verify'].includes(String(value.stageId))) fail();
  identifier(value.code, 'safe adapter failure code'); if (value.receipt !== undefined) readFlowReceipt(value.receipt);
  return freeze(value as unknown as ResourceFlowFailure);
}
export function readResourceFlowResumeInput(input: unknown): ResourceFlowResumeInput {
  const value = object(input, ['pauseToken', 'profileId']); digest(value.pauseToken); identifier(value.profileId, 'connection profile');
  return freeze(value as unknown as ResourceFlowResumeInput);
}
export function readResourceHandle(input: unknown): ResourceHandle {
  const value = object(input, ['id', 'kind', 'physicalId', 'scope', 'receipt']);
  identifier(value.id, 'resource handle'); identifier(value.kind, 'resource kind'); text(value.physicalId); text(value.scope);
  if (value.receipt !== undefined) readFlowReceipt(value.receipt);
  return freeze(value as unknown as ResourceHandle);
}
export function readConnectionDetails(input: unknown): ConnectionDetails {
  const value = object(input, ['profileId', 'resourceId', 'endpoint', 'protocol', 'credentialRef', 'trustRef']);
  identifier(value.profileId, 'connection profile'); identifier(value.resourceId, 'connection resource'); identifier(value.protocol, 'connection protocol');
  const endpoint = text(value.endpoint, 2048);
  let url: URL; try { url = new URL(endpoint); } catch { fail(); }
  if (url.username || url.password || url.search || url.hash || !url.hostname) fail();
  for (const key of ['credentialRef', 'trustRef']) if (value[key] !== undefined) identifier(value[key], key);
  return freeze(value as unknown as ConnectionDetails);
}
export function readVerificationResult(input: unknown): VerificationResult {
  const value = object(input, ['ok', 'checks', 'receipts']); if (typeof value.ok !== 'boolean') fail();
  const ids = new Set<string>(); const checks = list(value.checks, 4096);
  if (!checks.length) fail();
  for (const item of checks) { const check = object(item, ['id', 'passed']); const id = text(check.id, 256);
    if (ids.has(id) || typeof check.passed !== 'boolean') fail(); ids.add(id); }
  if (value.ok !== checks.every(item => (item as { passed: boolean }).passed)) fail();
  if (value.receipts !== undefined) list(value.receipts, 128).forEach(readFlowReceipt);
  return freeze(value as unknown as VerificationResult);
}
/** Browser-safe admission; unknown fields, accessors and unbounded payloads are refused. */
export function readResourceFlowState(input: unknown): ResourceFlowState {
  const value = object(input, ['version', 'kind', 'definitionDigest', 'configurationDigest', 'id', 'resourceId', 'label', 'mode', 'target', 'executionId', 'status', 'stages', 'events', 'segments', 'resource', 'details', 'connection', 'verification', 'pause', 'error', 'failure']);
  if (value.version !== 1 || value.kind !== 'resource-flow-state') fail(); digest(value.definitionDigest);
  readResourceFlowDefinition({ id: value.id, resourceId: value.resourceId, label: value.label, mode: value.mode, target: value.target, configurationDigest: value.configurationDigest });
  if (value.executionId !== null) text(value.executionId, 256);
  if (!['idle', 'running', 'paused', 'passed', 'failed', 'incomplete'].includes(String(value.status))) fail();
  const ids = ['acquire', 'details', 'connect', 'verify'];
  const stages = list(value.stages, 4); if (stages.length !== 4) fail();
  stages.forEach((item, index) => { const stage = object(item, ['id', 'label', 'status']);
    if (stage.id !== ids[index] || !['pending', 'running', 'waiting', 'passed', 'failed'].includes(String(stage.status))) fail(); text(stage.label, 160); });
  list(value.events, 100000).forEach((item, index) => { const event = object(item, ['sequence', 'executionId', 'stageId', 'status', 'timestamp', 'runtimeStageId']);
    if (event.sequence !== index + 1 || event.executionId !== value.executionId || !ids.includes(String(event.stageId))
      || !['running', 'waiting', 'passed', 'failed'].includes(String(event.status)) || !Number.isFinite(event.timestamp)) fail(); text(event.runtimeStageId, 256); });
  const projected = new Map(ids.map(id => [id, 'pending'])); let latestIndex = 0;
  for (const item of value.events as { stageId: string; status: string }[]) {
    const index = ids.indexOf(item.stageId), prior = projected.get(item.stageId)!;
    if (index < latestIndex || ids.slice(0, index).some(id => projected.get(id) !== 'passed')
      || (item.status === 'waiting' && item.stageId !== 'details')
      || (prior === 'pending' && item.status !== 'running') || ['passed', 'failed'].includes(prior)) fail();
    latestIndex = index; projected.set(item.stageId, item.status);
  }
  if (stages.some(item => projected.get((item as { id: string }).id) !== (item as { status: string }).status)) fail();
  const segmentIds = new Set<string>();
  list(value.segments, 1024).forEach((item, index, segments) => { const segment = object(item, ['runId', 'evidencePath', 'tracePath', 'status', 'resumedFromRunId']);
    text(segment.runId, 256); text(segment.evidencePath); text(segment.tracePath); optionalText(segment.resumedFromRunId);
    if (!['paused', 'passed', 'failed', 'incomplete'].includes(String(segment.status)) || segmentIds.has(String(segment.runId))) fail();
    if (index === 0 ? segment.resumedFromRunId !== undefined : segment.resumedFromRunId !== (segments[index - 1] as { runId: string }).runId
      || (segments[index - 1] as { status: string }).status !== 'paused') fail();
    segmentIds.add(String(segment.runId)); });
  if (value.resource !== undefined) readResourceHandle(value.resource);
  if (value.details !== undefined) readConnectionDetails(value.details);
  if (value.connection !== undefined) readFlowReceipt(value.connection);
  if (value.verification !== undefined) readVerificationResult(value.verification);
  if (value.failure !== undefined) {
    const failure = readResourceFlowFailure(value.failure);
    if (stages.find(item => (item as { id: string }).id === failure.stageId) && projected.get(failure.stageId) !== 'failed') fail();
  }
  const resource = value.resource as ResourceHandle | undefined, details = value.details as ConnectionDetails | undefined;
  if (resource && (resource.id !== value.resourceId || resource.scope !== (value.target as { scope: string }).scope)) fail();
  if (details && (!resource || details.resourceId !== resource.id)) fail();
  if (value.connection && !details) fail(); if (value.verification && !value.connection) fail();
  if (value.pause !== undefined) { const pause = object(value.pause, ['token', 'prompt', 'profiles']); digest(pause.token); text(pause.prompt, 160); readConnectionProfileChoices(pause.profiles); }
  if ((value.status === 'paused') !== (value.pause !== undefined)) fail(); optionalText(value.error);
  const allPassed = stages.every(item => (item as { status: string }).status === 'passed');
  if (value.status === 'idle' && (value.executionId !== null || (value.events as unknown[]).length || (value.segments as unknown[]).length
    || stages.some(item => (item as { status: string }).status !== 'pending') || value.resource || value.details || value.connection || value.verification)) fail();
  if (value.status !== 'idle' && value.executionId === null) fail();
  if (value.status === 'passed' && (!allPassed || !value.resource || !value.details || !value.connection
    || (value.verification as VerificationResult | undefined)?.ok !== true
    || (value.segments as { status: string }[]).at(-1)?.status !== 'passed')) fail();
  if (value.status === 'paused' && ((stages[0] as { status: string }).status !== 'passed'
    || (stages[1] as { status: string }).status !== 'waiting' || stages.slice(2).some(item => (item as { status: string }).status !== 'pending')
    || !value.resource || value.details || value.connection || value.verification || value.failure
    || (value.segments as { status: string }[]).at(-1)?.status !== 'paused')) fail();
  return freeze(value as unknown as ResourceFlowState);
}

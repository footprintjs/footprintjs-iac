import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import {readWorkflowEvidenceReferences} from '../delivery/evidence.ts';
import { readCheckResult } from '../checks/data.ts';
import { readReleaseManifestShape as readReleaseManifest } from '../releases/data.ts';
import type { JsonObject } from '../types.ts';
import type { PipelineDefinition, PipelineOperation, PipelineRecording, PipelineState, PipelineTarget, ReleaseObservation, RolloutPlan, RolloutReceipt, VerifiedRelease } from './types.ts';

export function fail(message = 'Invalid release pipeline data'): never { throw Error(message); }
export function object(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
  return value;
}
export function text(input: unknown, maximum = 256): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || /[\x00-\x1f\x7f]/.test(input)) fail();
  return input;
}
export function digest(input: unknown): string { const value = text(input, 71); if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) fail(); return value; }
export function list(input: unknown, maximum: number): unknown[] { if (!Array.isArray(input) || input.length > maximum) fail(); return input; }
export function jsonObject(input: unknown): JsonObject {
  const value = jsonCopy(input); if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 32768) fail(); return value;
}
export function readPipelineTarget(input: unknown): PipelineTarget {
  const value = object(input, ['id', 'scope']); identifier(value.id, 'pipeline target'); text(value.scope, 4096); return freeze(value as unknown as PipelineTarget);
}
export function readPipelineDefinition(input: unknown): PipelineDefinition {
  const value = object(input, ['version','id','label','configurationDigest','stages']);
  if (value.version !== 1) fail(); identifier(value.id, 'pipeline'); text(value.label, 160); digest(value.configurationDigest);
  const stages = list(value.stages, 32), ids = new Set<string>(); if (!stages.length) fail();
  for (const item of stages) {
    const stage = object(item, ['id','label','target','strategyId','adapterId','parameters','checks','rollback','promotion']);
    const id = identifier(stage.id, 'pipeline stage'); if (ids.has(id)) fail(); ids.add(id); text(stage.label,160); readPipelineTarget(stage.target);
    identifier(stage.strategyId, 'rollout strategy'); identifier(stage.adapterId, 'rollout adapter');
    if (stage.parameters !== undefined) jsonObject(stage.parameters);
    if (!['disabled','manual','automatic'].includes(String(stage.rollback)) || !['automatic','manual'].includes(String(stage.promotion))) fail();
    const checks = list(stage.checks, 32), checkIds = new Set<string>(); if (!checks.length) fail('Every pipeline stage requires measured acceptance checks');
    for (const item of checks) {
      const check = object(item, ['runnerId','suiteId','suiteDigest']); identifier(check.runnerId,'check runner'); identifier(check.suiteId,'check suite'); digest(check.suiteDigest);
      const id = String(check.runnerId) + '/' + String(check.suiteId); if (checkIds.has(id)) fail(); checkIds.add(id);
    }
  }
  return freeze(value as unknown as PipelineDefinition);
}
export function readRolloutPlan(input: unknown): RolloutPlan {
  const value = object(input, ['steps']), steps = list(value.steps, 128), ids = new Set<string>(); if (!steps.length) fail();
  for (const item of steps) {
    const step = object(item, ['kind','id','operation','parameters']), id = identifier(step.id,'rollout step'); if (ids.has(id)) fail(); ids.add(id);
    if (step.kind === 'action') { identifier(step.operation,'rollout operation'); if (step.parameters !== undefined) jsonObject(step.parameters); }
    else if (step.kind !== 'check' || step.operation !== undefined || step.parameters !== undefined) fail();
  }
  if (!steps.some(item => (item as {kind: string}).kind === 'action')) fail();
  return freeze(value as unknown as RolloutPlan);
}
export function readRolloutReceipt(input: unknown): RolloutReceipt {
  const value = object(input, ['status','reference','metadata','changes','evidence']);
  if(value.evidence!==undefined)readWorkflowEvidenceReferences(value.evidence);
  if (!['succeeded','failed','unknown'].includes(String(value.status))) fail();
  if (value.reference !== undefined) text(value.reference,4096);
  if (value.metadata !== undefined) jsonObject(value.metadata);
  if (value.changes !== undefined) {
    const ids = new Set<string>();
    for (const item of list(value.changes,4096)) {
      const change = object(item,['resourceId','action']), id = identifier(change.resourceId,'changed resource');
      if (ids.has(id) || !['create','update','verify','delete','noop','replace'].includes(String(change.action))) fail(); ids.add(id);
    }
  }
  return freeze(value as unknown as RolloutReceipt);
}
export function readReleaseObservation(input: unknown): ReleaseObservation {
  const value = object(input, ['known','releaseDigest']);
  if (typeof value.known !== 'boolean' || !value.known && value.releaseDigest !== null) fail();
  if (value.releaseDigest !== null) digest(value.releaseDigest);
  return freeze(value as unknown as ReleaseObservation);
}
export function readPipelineRecording(input: unknown): PipelineRecording {
  const value = object(input, ['runId','evidencePath','tracePath','status','stageId','kind']);
  identifier(value.stageId,'recorded stage'); text(value.runId); text(value.evidencePath,4096); text(value.tracePath,4096);
  if (!['passed','failed','incomplete'].includes(String(value.status)) || !['rollout','recovery'].includes(String(value.kind))) fail();
  return freeze(value as unknown as PipelineRecording);
}
export function readVerifiedRelease(input: unknown): VerifiedRelease {
  const value = object(input, ['release','verifiedAt','recording']); readReleaseManifest(value.release); const recording = readPipelineRecording(value.recording);
  if (!Number.isFinite(value.verifiedAt) || Number(value.verifiedAt) <= 0 || recording.status !== 'passed') fail();
  return freeze(value as unknown as VerifiedRelease);
}
export function readPipelineOperation(input: unknown): PipelineOperation {
  const value = object(input, ['id','kind','status','operation','releaseDigest','receipt','check','observation']);
  identifier(value.id, 'pipeline operation'); digest(value.releaseDigest);
  if (!['action','check','observe'].includes(String(value.kind)) || !['intent','succeeded','failed','unknown'].includes(String(value.status))) fail();
  if (value.operation !== undefined) identifier(value.operation,'operation');
  if (value.receipt !== undefined) {
    const receipt = readRolloutReceipt(value.receipt); if (value.kind !== 'action' || value.status !== receipt.status) fail();
  }
  if (value.check !== undefined) {
    const check = readCheckResult(value.check); if (value.kind !== 'check' || value.status !== (check.status === 'passed' ? 'succeeded' : 'failed') || check.request.releaseDigest !== value.releaseDigest) fail();
  }
  if (value.observation !== undefined) {
    const observation = readReleaseObservation(value.observation);
    if (value.kind !== 'observe' || value.status !== (observation.known ? 'succeeded' : 'unknown')) fail();
  }
  if (value.status === 'intent' && (value.receipt || value.check || value.observation)) fail();
  return freeze(value as unknown as PipelineOperation);
}
export function readPipelineState(input: unknown): PipelineState {
  const value = object(input, ['version','kind','definition','definitionDigest','release','executionId','status','stages','events','recordings','pendingAction','error']);
  if (value.version !== 1 || value.kind !== 'release-pipeline') fail(); const definition = readPipelineDefinition(value.definition); const release = readReleaseManifest(value.release); digest(value.definitionDigest);
  if (value.executionId !== null) text(value.executionId);
  if (!['idle','running','waiting','passed','failed','incomplete'].includes(String(value.status))) fail();
  if (value.error !== undefined) text(value.error,1024);
  const stages = list(value.stages,32); if (stages.length !== definition.stages.length) fail();
  for (const [index,item] of stages.entries()) {
    const stage = object(item,['id','label','status','phase','operations','baseline','lastApplied','lastVerified']);
    if (stage.id !== definition.stages[index]!.id || stage.label !== definition.stages[index]!.label || !['pending','waiting','running','passed','failed','rolled-back','incomplete'].includes(String(stage.status))) fail();
    text(stage.phase,160); const ids = new Set<string>();
    for (const item of list(stage.operations, 4096)) { const op = readPipelineOperation(item); if (ids.has(op.id)) fail(); ids.add(op.id); }
    if (stage.baseline !== undefined) readVerifiedRelease(stage.baseline);
    if (stage.lastApplied !== undefined) digest(stage.lastApplied); if (stage.lastVerified !== undefined) digest(stage.lastVerified);
    if (stage.status === 'passed' && (stage.lastVerified !== release.digest || stage.lastApplied !== release.digest)) fail();
  }
  const recordings = list(value.recordings,64).map(readPipelineRecording);
  if (new Set(recordings.map(item => item.runId)).size !== recordings.length) fail();
  for (const [index,item] of list(value.events,16384).entries()) {
    const event = object(item,['sequence','executionId','stageId','phase','status','timestamp','runtimeStageId']);
    if (event.sequence !== index + 1 || event.executionId !== value.executionId || !definition.stages.some(stage => stage.id === event.stageId)
      || !['running','passed','failed','incomplete','rolled-back'].includes(String(event.status)) || !Number.isFinite(event.timestamp)) fail();
    text(event.phase,160); text(event.runtimeStageId,256);
  }
  if (value.pendingAction !== undefined) {
    const action = object(value.pendingAction,['stageId','token','releaseDigest','kind']); text(action.token); digest(action.releaseDigest);
    if (!['promote','recover'].includes(String(action.kind)) || action.releaseDigest !== release.digest || value.status !== 'waiting') fail();
    const stageIndex = definition.stages.findIndex(stage => stage.id === action.stageId), state = stages[stageIndex] as {status: string} | undefined;
    if (!state || state.status !== (action.kind === 'promote' ? 'waiting' : 'failed') || stages.slice(0,stageIndex).some(item => (item as {status: string}).status !== 'passed')) fail();
    if (action.kind === 'promote' ? definition.stages[stageIndex]!.promotion !== 'manual' : definition.stages[stageIndex]!.rollback !== 'manual') fail();
  } else if (value.status === 'waiting') fail();
  if (value.status === 'passed' && stages.some(item => (item as {status: string}).status !== 'passed')) fail();
  if (value.status !== 'idle' && value.executionId === null) fail();
  if (value.status === 'failed' && !stages.some(item => ['failed','rolled-back'].includes((item as {status:string}).status))) fail();
  if (!['idle','running','incomplete'].includes(String(value.status))) {
    for (const item of stages) {
      const stage = item as {id:string;status:string;operations:PipelineOperation[];baseline?:VerifiedRelease;lastApplied?:string;lastVerified?:string};
      if (stage.status === 'pending') continue;
      const receipt = recordings.findLast(recording => recording.stageId === stage.id);
      if (!receipt || stage.status === 'passed' && receipt.status !== 'passed' || stage.status === 'failed' && receipt.status !== 'failed'
        || stage.status === 'rolled-back' && (receipt.status !== 'passed' || receipt.kind !== 'recovery' || !stage.baseline || stage.lastApplied !== stage.baseline.release.digest || stage.lastVerified !== stage.baseline.release.digest)) fail();
      if (stage.status === 'passed' && stage.operations.some(operation => operation.status !== 'succeeded')) fail();
    }
  }
  if (value.status === 'idle' && (value.executionId !== null || (value.events as unknown[]).length || recordings.length || stages.some(item => (item as {status: string}).status !== 'pending'))) fail();
  return freeze(value as unknown as PipelineState);
}

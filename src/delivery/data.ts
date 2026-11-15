import { freeze, identifier, jsonCopy } from '../graph/data.ts';
import {readWorkflowEvidenceReferences} from './evidence.ts';
import { DELIVERY_STAGE_IDS, type DeliveryArtifact, type DeliveryBuild, type DeliveryDefinition, type DeliveryDeployment,
  type DeliveryPlan, type DeliveryPublication, type DeliveryState, type DeliveryVerification, type SourceRevision, type SourceSnapshot } from './types.ts';

function fail(): never { throw Error('Unsupported delivery data'); }
function object(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = jsonCopy(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
  return value;
}
function text(input: unknown, max = 4096): string {
  if (typeof input !== 'string' || !input.length || input.length > max || /[\x00-\x1f\x7f]/.test(input)) fail(); return input;
}
function digest(input: unknown): void { if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(text(input, 71))) fail(); }
function list(input: unknown, max: number): unknown[] { if (!Array.isArray(input) || input.length > max) fail(); return input; }
function metadata(value: unknown): void {
  if (value === undefined) return;
  const copy = jsonCopy(value); if (!copy || typeof copy !== 'object' || Array.isArray(copy) || JSON.stringify(copy).length > 128 * 1024) fail();
}
function optionalText(input: unknown): void { if (input !== undefined) text(input); }
export function readDeliveryDefinition(input: unknown): DeliveryDefinition {
  const value = object(input, ['id', 'label', 'target', 'source', 'recipe', 'configurationDigest']);
  identifier(value.id, 'delivery ID'); text(value.label, 160); digest(value.configurationDigest);
  const target = object(value.target, ['id', 'scope']); identifier(target.id, 'delivery target'); text(target.scope);
  const source = object(value.source, ['repository', 'ref']); text(source.repository, 2048); text(source.ref, 256);
  // A repository identifier may be a host-approved local path or URL, but never carry URL credentials.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(source.repository))) {
    let url: URL; try { url = new URL(String(source.repository)); } catch { fail(); }
    if (url.username || url.password || url.search || url.hash) fail();
  }
  const recipe = object(value.recipe, ['id', 'digest']); identifier(recipe.id, 'delivery build recipe'); digest(recipe.digest);
  return freeze(value as unknown as DeliveryDefinition);
}
export function readSourceRevision(input: unknown): SourceRevision {
  const value = object(input, ['repository', 'ref', 'commit', 'tree']); text(value.repository, 2048); text(value.ref, 256);
  for (const key of ['commit', 'tree']) if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(text(value[key], 64))) fail();
  return freeze(value as unknown as SourceRevision);
}
export function readSourceSnapshot(input: unknown): SourceSnapshot {
  const value = object(input, ['revision', 'location']); readSourceRevision(value.revision); text(value.location);
  return freeze(value as unknown as SourceSnapshot);
}
export function readDeliveryArtifacts(input: unknown): DeliveryArtifact[] {
  const ids = new Set<string>(), values = list(jsonCopy(input), 128); if (!values.length) fail();
  for (const item of values) { const value = object(item, ['id', 'digest', 'reference']);
    const id = identifier(value.id, 'delivery artifact'); if (ids.has(id)) fail(); ids.add(id);
    digest(value.digest); const reference = text(value.reference);
    if (/[?#]/.test(reference) || /^[^/]*:[^/]*@/.test(reference)) fail();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) { let url: URL; try { url = new URL(reference); } catch { fail(); } if (url.username || url.password || url.search || url.hash) fail(); }
  }
  return freeze(values as unknown as DeliveryArtifact[]);
}
export function readDeliveryBuild(input: unknown): DeliveryBuild {
  const value = object(input, ['artifacts', 'recipeDigest', 'metadata']); readDeliveryArtifacts(value.artifacts); digest(value.recipeDigest); metadata(value.metadata);
  return freeze(value as unknown as DeliveryBuild);
}
export function readDeliveryPublication(input: unknown): DeliveryPublication {
  const value = object(input, ['artifacts', 'metadata']); readDeliveryArtifacts(value.artifacts); metadata(value.metadata);
  return freeze(value as unknown as DeliveryPublication);
}
export function readDeliveryPlan(input: unknown): DeliveryPlan {
  const value = object(input, ['id', 'digest', 'changes', 'metadata','evidence']); text(value.id, 256); digest(value.digest); metadata(value.metadata);
  if(value.evidence!==undefined)readWorkflowEvidenceReferences(value.evidence);
  const ids = new Set<string>();
  for (const item of list(value.changes, 4096)) { const change = object(item, ['resourceId', 'action']);
    const id = identifier(change.resourceId, 'planned resource'); if (ids.has(id)) fail(); ids.add(id);
    if (!['create', 'update', 'verify', 'delete', 'noop'].includes(String(change.action))) fail();
  }
  return freeze(value as unknown as DeliveryPlan);
}
export function readDeliveryDeployment(input: unknown): DeliveryDeployment {
  const value = object(input, ['ok', 'runId', 'evidencePath', 'tracePath', 'metadata','evidence']); if (typeof value.ok !== 'boolean') fail();
  if(value.evidence!==undefined)readWorkflowEvidenceReferences(value.evidence);
  optionalText(value.runId); optionalText(value.evidencePath); optionalText(value.tracePath); metadata(value.metadata);
  return freeze(value as unknown as DeliveryDeployment);
}
export function readDeliveryVerification(input: unknown): DeliveryVerification {
  const value = object(input, ['ok', 'checks', 'metadata']); if (typeof value.ok !== 'boolean') fail(); metadata(value.metadata);
  const checks = list(value.checks, 4096), ids = new Set<string>(); if (!checks.length) fail();
  for (const item of checks) { const check = object(item, ['id', 'passed']); const id = text(check.id, 256);
    if (ids.has(id) || typeof check.passed !== 'boolean') fail(); ids.add(id); }
  if (value.ok !== checks.every(check => (check as { passed: boolean }).passed)) fail();
  return freeze(value as unknown as DeliveryVerification);
}
export function readDeliveryState(input: unknown): DeliveryState {
  const value = object(input, ['version', 'kind', 'definition', 'definitionDigest', 'executionId', 'status', 'stages', 'events', 'results', 'recordings', 'error']);
  if (value.version !== 1 || value.kind !== 'delivery-state') fail(); readDeliveryDefinition(value.definition); digest(value.definitionDigest);
  if (value.executionId !== null) text(value.executionId, 256);
  if (!['idle', 'running', 'passed', 'failed', 'incomplete'].includes(String(value.status))) fail(); optionalText(value.error);
  const stages = list(value.stages, 7); if (stages.length !== 7) fail();
  stages.forEach((item, index) => { const stage = object(item, ['id', 'label', 'status']);
    if (stage.id !== DELIVERY_STAGE_IDS[index] || !['pending', 'running', 'passed', 'failed'].includes(String(stage.status))) fail(); text(stage.label, 160); });
  const projected = new Map<string, string>(DELIVERY_STAGE_IDS.map(id => [id, 'pending'])); let lastIndex = 0;
  for (const [index, item] of list(value.events, 64).entries()) {
    const event = object(item, ['sequence', 'executionId', 'stageId', 'status', 'timestamp', 'runtimeStageId']);
    const stageIndex = DELIVERY_STAGE_IDS.indexOf(event.stageId as typeof DELIVERY_STAGE_IDS[number]);
    if (event.sequence !== index + 1 || event.executionId !== value.executionId || stageIndex < lastIndex || stageIndex < 0
      || !['running', 'passed', 'failed'].includes(String(event.status)) || !Number.isFinite(event.timestamp)) fail();
    if (DELIVERY_STAGE_IDS.slice(0, stageIndex).some(id => projected.get(id) !== 'passed')) fail();
    const previous = projected.get(String(event.stageId));
    if (previous === 'pending' ? event.status !== 'running' : previous !== 'running' || event.status === 'running') fail();
    projected.set(String(event.stageId), String(event.status)); lastIndex = stageIndex; text(event.runtimeStageId, 256);
  }
  if (stages.some(item => projected.get((item as { id: string }).id) !== (item as { status: string }).status)) fail();
  const results = object(value.results, ['revision', 'source', 'build', 'publication', 'plan', 'deployment', 'verification']);
  for (const [key, reader] of RESULT_READERS) if (results[key] !== undefined) reader(results[key]);
  const definition = value.definition as DeliveryDefinition, revision = results.revision as SourceRevision | undefined;
  if (revision && (revision.repository !== definition.source.repository || revision.ref !== definition.source.ref)) fail();
  const source = results.source as SourceSnapshot | undefined;
  if (source && (!revision || ['repository', 'ref', 'commit', 'tree'].some(key => source.revision[key as keyof SourceRevision] !== revision[key as keyof SourceRevision]))) fail();
  const build = results.build as DeliveryBuild | undefined, publication = results.publication as DeliveryPublication | undefined;
  if (build && (!source || build.recipeDigest !== definition.recipe.digest)) fail();
  if (publication && (!build || publication.artifacts.length !== build.artifacts.length
    || publication.artifacts.some(artifact => !build.artifacts.some(original => original.id === artifact.id && original.digest === artifact.digest)))) fail();
  if (results.plan && !publication || results.deployment && !results.plan || results.verification && !results.deployment) fail();
  RESULT_READERS.forEach(([key], index) => {
    const status = (stages[index] as { status: string }).status;
    if (status === 'passed' && results[key] === undefined || status === 'pending' && results[key] !== undefined) fail();
  });
  const recordings = list(value.recordings, 1);
  for (const item of recordings) { const recording = object(item, ['runId', 'evidencePath', 'tracePath', 'status']);
    text(recording.runId, 256); text(recording.evidencePath); text(recording.tracePath); if (!['passed', 'failed', 'incomplete'].includes(String(recording.status))) fail(); }
  if (value.status === 'idle' && (value.executionId !== null || (value.events as unknown[]).length || Object.keys(results).length || recordings.length)) fail();
  if (value.status !== 'idle' && value.executionId === null) fail();
  if (value.status === 'failed' && !stages.some(stage => (stage as { status: string }).status === 'failed')) fail();
  if (value.status === 'passed' && (!stages.every(stage => (stage as { status: string }).status === 'passed')
    || RESULT_READERS.some(([key]) => results[key] === undefined) || (results.deployment as DeliveryDeployment).ok !== true
    || (results.verification as DeliveryVerification).ok !== true || (recordings[0] as { status: string } | undefined)?.status !== 'passed')) fail();
  return freeze(value as unknown as DeliveryState);
}
export const RESULT_READERS = [
  ['revision', readSourceRevision], ['source', readSourceSnapshot], ['build', readDeliveryBuild], ['publication', readDeliveryPublication],
  ['plan', readDeliveryPlan], ['deployment', readDeliveryDeployment], ['verification', readDeliveryVerification],
] as const;

import { array, freeze, jsonCopy, keys, object, text } from '../graph/data.ts';
import { canonical } from '../util.ts';
import { diffSystemRevisions } from './diff.ts';
import { fingerprintPlan, readReviewedPlan } from './plan.ts';
import { digestValue, optionalDigest, readMasterTarget, readSystemRevision } from './revision.ts';
import type { MasterAttempt, MasterReview, MasterState, SystemRevision } from './types.ts';

export const emptyMasterState = (): MasterState => ({ kind: 'master-system-state', schemaVersion: 1,
  target: null, appliedDigest: null, candidateDigest: null, revisions: [], attempts: [] });
export function findRevision(state: MasterState, digest: string | null): SystemRevision | undefined {
  return digest === null ? undefined : state.revisions.find(row => row.digest === digest);
}
function time(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw Error('Invalid master timestamp');
  return value;
}
function label(value: unknown, where: string): string {
  const result = text(value, where); if (!result || result.length > 4096 || /[\x00-\x1f\x7f]/.test(result)) throw Error(`Invalid ${where}`); return result;
}
function attempt(input: unknown): MasterAttempt {
  const row = object(jsonCopy(input), 'master attempt');
  keys(row, ['attemptId', 'revisionDigest', 'previousAppliedDigest', 'status', 'kind', 'startedAt', 'finishedAt', 'reviewId',
    'planDigest', 'runId', 'evidencePath', 'tracePath', 'message', 'actions'], 'master attempt');
  label(row.attemptId, 'attempt id'); digestValue(row.revisionDigest, 'attempt revision'); optionalDigest(row.previousAppliedDigest, 'previous applied revision');
  if (!['running', 'applied', 'failed', 'incomplete'].includes(String(row.status)) || !['adopt', 'apply'].includes(String(row.kind))) throw Error('Invalid master attempt status');
  time(row.startedAt);
  if (row.finishedAt !== undefined) time(row.finishedAt);
  if ((row.status === 'running') !== (row.finishedAt === undefined)) throw Error('Master attempt completion metadata disagrees');
  for (const key of ['reviewId', 'runId', 'evidencePath', 'tracePath', 'message']) if (row[key] !== undefined) label(row[key], `attempt ${key}`);
  if (row.planDigest !== undefined) digestValue(row.planDigest, 'attempt plan digest');
  if (row.status === 'applied' && (row.runId === undefined || row.evidencePath === undefined)) throw Error('Applied master attempt lacks native evidence');
  if (row.actions !== undefined) for (const value of array(row.actions, 'attempt actions')) {
    const action = object(value, 'attempt action'); keys(action, ['resourceId', 'action'], 'attempt action');
    label(action.resourceId, 'attempt resource');
    if (!['create', 'update', 'verify', 'noop', 'delete'].includes(String(action.action))) throw Error('Invalid master action');
  }
  return row as unknown as MasterAttempt;
}
function review(input: unknown, state: MasterState): MasterReview {
  const row = object(jsonCopy(input), 'master review');
  keys(row, ['reviewId', 'candidateDigest', 'parentDigest', 'planDigest', 'plannedAt', 'prune', 'plan', 'changes'], 'master review');
  label(row.reviewId, 'review id'); time(row.plannedAt);
  if (typeof row.prune !== 'boolean' || row.candidateDigest !== state.candidateDigest || row.parentDigest !== state.appliedDigest) throw Error('Master review is stale');
  const candidate = findRevision(state, state.candidateDigest);
  if (!candidate) throw Error('Master review candidate is unavailable');
  const plan = readReviewedPlan(row.plan);
  if (plan.stack !== candidate.graph.name || fingerprintPlan(plan) !== row.planDigest) throw Error('Master reviewed plan digest mismatch');
  const changes = diffSystemRevisions(findRevision(state, state.appliedDigest), candidate);
  if (canonical(row.changes) !== canonical(changes)) throw Error('Master review declaration changes mismatch');
  return { reviewId: String(row.reviewId), candidateDigest: candidate.digest, parentDigest: state.appliedDigest,
    planDigest: String(row.planDigest), plannedAt: String(row.plannedAt), prune: row.prune, plan, changes };
}
/** Stored history is admitted as data; unknown/partial state is never replaced with an empty system. */
export function readMasterState(input: unknown): MasterState {
  const row = object(jsonCopy(input), 'master state');
  keys(row, ['kind', 'schemaVersion', 'target', 'appliedDigest', 'candidateDigest', 'revisions', 'attempts', 'review'], 'master state');
  if (row.kind !== 'master-system-state' || row.schemaVersion !== 1) throw Error('Unsupported master state');
  const revisions = array(row.revisions, 'master revisions').map(readSystemRevision), attempts = array(row.attempts, 'master attempts').map(attempt);
  const target = row.target === null ? null : readMasterTarget(row.target), seen = new Set<string>(), names = new Set<string>();
  for (const revision of revisions) {
    if (!target || canonical(revision.target) !== canonical(target) || seen.has(revision.digest) || names.has(revision.revisionId)
      || (revision.parentDigest !== null && !seen.has(revision.parentDigest))
      || (revisions[0] && revision.graph.name !== revisions[0].graph.name)) throw Error('Invalid master revision history');
    seen.add(revision.digest); names.add(revision.revisionId);
  }
  const appliedDigest = optionalDigest(row.appliedDigest, 'applied digest'), candidateDigest = optionalDigest(row.candidateDigest, 'candidate digest');
  for (const digest of [appliedDigest, candidateDigest]) if (digest !== null && !seen.has(digest)) throw Error('Master head refers to an absent revision');
  const ids = new Set<string>();
  for (const item of attempts) {
    if (ids.has(item.attemptId) || !seen.has(item.revisionDigest)
      || (item.previousAppliedDigest !== null && !seen.has(item.previousAppliedDigest))) throw Error('Invalid master attempt history');
    ids.add(item.attemptId);
  }
  if (attempts.filter(item => item.status === 'running').length > 1) throw Error('Conflicting active master attempts');
  const successful = attempts.filter(item => item.status === 'applied');
  if ((successful.at(-1)?.revisionDigest ?? null) !== appliedDigest) throw Error('Master head disagrees with its applied history');
  if (!target && (revisions.length || attempts.length)) throw Error('Unbound master history');
  const state: MasterState = { kind: 'master-system-state', schemaVersion: 1, target, appliedDigest, candidateDigest, revisions, attempts };
  if (row.review !== undefined) state.review = review(row.review, state);
  return freeze(state);
}

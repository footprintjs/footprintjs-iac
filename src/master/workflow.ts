import { randomUUID } from 'node:crypto';
import type { ApplyResult, InfraEngine } from '../engine.ts';
import { canonical, fingerprint } from '../util.ts';
import { diffSystemRevisions } from './diff.ts';
import { verifyRevisionOutcome } from './evidence.ts';
import { fingerprintPlan } from './plan.ts';
import { readMasterTarget, readSystemRevision } from './revision.ts';
import { findRevision } from './state.ts';
import { FileMasterStore } from './store.ts';
import type { MasterAttempt, MasterReview, MasterState, MasterTarget, SystemRevision } from './types.ts';

/** Host-only composition. JSON inputs never choose engines, credentials, commands or storage paths. */
export class MasterWorkflow {
  private readonly engine: Pick<InfraEngine, 'plan' | 'apply'>;
  private readonly store: FileMasterStore;
  private readonly target: MasterTarget;
  constructor(options: { engine: Pick<InfraEngine, 'plan' | 'apply'>; store: FileMasterStore; target: MasterTarget }) {
    this.engine = options.engine; this.store = options.store; this.target = readMasterTarget(options.target);
  }
  getState(): Promise<MasterState> { return this.store.load(); }

  async stage(input: SystemRevision, options: { expectedAppliedDigest: string | null }): Promise<MasterState> {
    const revision = this.admit(input);
    return this.store.withLock(async () => {
      const state = structuredClone(await this.store.load()); this.idle(state);
      if (state.appliedDigest !== options.expectedAppliedDigest) throw Error('Applied master revision changed; review the current head');
      this.add(state, revision);
      this.parent(state, revision); state.candidateDigest = revision.digest; delete state.review;
      await this.store.save(state); return this.store.load();
    });
  }

  async preview(options: { prune?: boolean } = {}): Promise<MasterReview> {
    return this.store.withLock(async () => {
      const state = structuredClone(await this.store.load()); this.idle(state);
      const revision = findRevision(state, state.candidateDigest); if (!revision) throw Error('Stage a system revision before reviewing it');
      this.admit(revision); this.parent(state, revision);
      const changes = diffSystemRevisions(findRevision(state, state.appliedDigest), revision);
      if (changes.counts.removed && !options.prune) throw Error('Removing resources needs an explicit prune review');
      const plan = await this.engine.plan(revision.graph, { prune: options.prune === true });
      const planDigest = fingerprintPlan(plan);
      const review: MasterReview = { reviewId: fingerprint({ nonce: randomUUID(), candidateDigest: revision.digest, parentDigest: state.appliedDigest, planDigest }),
        candidateDigest: revision.digest, parentDigest: state.appliedDigest,
        planDigest, plannedAt: new Date().toISOString(), prune: options.prune === true, plan, changes };
      state.review = review; await this.store.save(state); return (await this.store.load()).review!;
    });
  }

  /** Existing complete native evidence plus a current all-noop plan admits the baseline without effects. */
  async adopt(input: SystemRevision, result: ApplyResult): Promise<MasterState> {
    const revision = this.admit(input);
    return this.store.withLock(async () => {
      const state = structuredClone(await this.store.load()); this.idle(state);
      if (state.appliedDigest !== null || revision.parentDigest !== null || state.attempts.length
        || (state.candidateDigest !== null && state.candidateDigest !== revision.digest)) throw Error('Only an empty master history can adopt a baseline');
      await verifyRevisionOutcome(revision, result);
      if (!result.ok) throw Error('A failed deployment cannot be adopted');
      const current = await this.engine.plan(revision.graph);
      if (current.operations.length !== revision.graph.resources.length || current.operations.some(operation => operation.action !== 'noop')) {
        throw Error('Baseline is not the current ready system; reconcile and record it first');
      }
      this.add(state, revision);
      const now = new Date().toISOString();
      state.attempts.push({ attemptId: randomUUID(), kind: 'adopt', revisionDigest: revision.digest, previousAppliedDigest: null,
        status: 'applied', startedAt: now, finishedAt: now, ...this.native(result) });
      state.appliedDigest = revision.digest; state.candidateDigest = null; delete state.review;
      await this.store.save(state); return this.store.load();
    });
  }

  /** The sealed review is checked before native effects; the engine replans under its own state lock. */
  async apply(reviewId: string): Promise<ApplyResult> {
    return this.store.withLock(async () => {
      const state = structuredClone(await this.store.load()); this.idle(state);
      const review = state.review, revision = findRevision(state, state.candidateDigest);
      if (!review || !revision || review.reviewId !== reviewId || review.candidateDigest !== revision.digest
        || review.parentDigest !== state.appliedDigest || fingerprintPlan(review.plan) !== review.planDigest) throw Error('The master review is stale; review the candidate again');
      this.admit(revision); this.parent(state, revision);
      const index = state.attempts.length;
      state.attempts.push({ attemptId: randomUUID(), kind: 'apply', revisionDigest: revision.digest,
        previousAppliedDigest: state.appliedDigest, status: 'running', startedAt: new Date().toISOString(),
        reviewId: review.reviewId, planDigest: review.planDigest });
      delete state.review;
      await this.store.save(state); // Master intent is durable before the native engine can touch a provider.
      let result: ApplyResult;
      try {
        result = await this.engine.apply(revision.graph, { prune: review.prune, expectedPlanDigest: review.planDigest });
        await verifyRevisionOutcome(revision, result);
        if (fingerprintPlan(result.plan) !== review.planDigest || state.attempts.some(attempt => attempt.runId === result.runId)) {
          throw Error('Native outcome does not belong to this newly reviewed attempt');
        }
      } catch (error) {
        state.attempts[index] = { ...state.attempts[index]!, status: 'incomplete', finishedAt: new Date().toISOString(),
          message: 'No complete admitted native outcome was returned; inspect resource and recording state before reviewing again' };
        await this.store.save(state); throw error;
      }
      state.attempts[index] = { ...state.attempts[index]!, status: result.ok ? 'applied' : 'failed',
        finishedAt: new Date().toISOString(), ...this.native(result) };
      if (result.ok) { state.appliedDigest = revision.digest; state.candidateDigest = null; }
      await this.store.save(state); return result;
    });
  }

  private admit(input: SystemRevision): SystemRevision {
    const revision = readSystemRevision(input);
    if (canonical(revision.target) !== canonical(this.target)) throw Error('Revision target differs from this workflow binding');
    return revision;
  }
  private idle(state: MasterState): void {
    if (state.target && canonical(state.target) !== canonical(this.target)) throw Error('Master history belongs to another target');
    if (state.attempts.some(attempt => attempt.status === 'running')) throw Error('A prior master attempt is unfinished; inspect its outcome before continuing');
  }
  private parent(state: MasterState, revision: SystemRevision): void {
    if (revision.digest !== state.appliedDigest && revision.parentDigest !== state.appliedDigest) throw Error('Candidate parent is not the applied master revision');
  }
  private add(state: MasterState, revision: SystemRevision): void {
    if (state.revisions.some(row => row.revisionId === revision.revisionId && row.digest !== revision.digest)) throw Error('Revision IDs are immutable; use a new revision ID');
    if (state.revisions.length && state.revisions[0]!.graph.name !== revision.graph.name) throw Error('Revision stack differs from the master system');
    state.target ??= revision.target;
    if (!state.revisions.some(row => row.digest === revision.digest)) state.revisions.push(revision);
  }
  private native(result: ApplyResult): Pick<MasterAttempt, 'runId' | 'evidencePath' | 'tracePath' | 'actions'> {
    return { runId: result.runId, evidencePath: result.evidencePath,
      ...(result.tracePath ? { tracePath: result.tracePath } : {}),
      actions: result.plan.operations.map(operation => ({ resourceId: operation.resource.id, action: operation.action })) };
  }
}

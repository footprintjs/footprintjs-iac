import { randomUUID } from 'node:crypto';
import { identifier } from '../graph/data.ts';
import { canonical, fingerprint } from '../util.ts';
import { CheckRunnerRegistry } from '../checks/registry.ts';
import { FileCheckStore } from '../checks/store.ts';
import { CheckWorkflow } from '../checks/workflow.ts';
import { readCheckRequest } from '../checks/data.ts';
import type { CheckRequest, CheckRunner } from '../checks/types.ts';
import { readTriggerDefinition, readTriggerJob, readTriggerSignal, time } from './data.ts';
import { TriggerStoreBusyError } from './store.ts';
import type { DeployedRelease, TriggerAdapter, TriggerCandidate, TriggerCapability, TriggerDefinition, TriggerDispatch, TriggerInvocation, TriggerJobState, TriggerSignal, TriggerStore } from './types.ts';

export interface TriggerDispatcherOptions {
  definitions: readonly TriggerDefinition[]; adapters: readonly TriggerAdapter[]; checks: readonly CheckRunner[]; store: TriggerStore;
  /** Actual deployed identity is re-read for every dispatch, including scheduled monitors. */
  readCurrent(definition: TriggerDefinition): Promise<DeployedRelease | undefined>;
  clock?: () => number; leaseMs?: number;
}
/** A finite scheduler entry point. The scheduler host owns wakeups, authentication and process lifetime. */
export class TriggerDispatcher {
  private readonly definitions: readonly TriggerDefinition[]; private readonly adapters: Map<string, TriggerAdapter>;
  private readonly checks: Map<string, CheckRunner>; private readonly clock: () => number; private readonly leaseMs: number;
  private readonly options: TriggerDispatcherOptions;
  constructor(options: TriggerDispatcherOptions) {
    this.options = options;
    if (!Array.isArray(options.definitions) || !options.definitions.length || options.definitions.length > 128) throw Error('Register a bounded trigger catalog');
    this.definitions = Object.freeze(options.definitions.map(readTriggerDefinition));
    if (new Set(this.definitions.map(item => item.id)).size !== this.definitions.length) throw Error('Duplicate trigger registration');
    this.adapters = new Map();
    for (const adapter of options.adapters) {
      identifier(adapter.id, 'trigger adapter');
      if (this.adapters.has(adapter.id) || typeof adapter.admit !== 'function' || typeof adapter.prepare !== 'function') throw Error('Invalid trigger adapter registration');
      this.adapters.set(adapter.id, adapter);
    }
    const catalog = new CheckRunnerRegistry(options.checks).catalog(); this.checks = new Map(options.checks.map(check => [check.id, check]));
    for (const definition of this.definitions) {
      const adapter = this.adapters.get(definition.adapterId);
      if (!adapter || adapter.kind !== definition.kind) throw Error('Choose a registered trigger adapter');
      adapter.admit(definition);
      if (!catalog.find(runner => runner.id === definition.runnerId)?.suites.some(suite => suite.id === definition.suiteId && suite.digest === definition.suiteDigest)) throw Error('Trigger suite differs from registered immutable check suite');
    }
    this.clock = options.clock ?? Date.now; this.leaseMs = options.leaseMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 || this.leaseMs > 24 * 60 * 60_000 || typeof options.readCurrent !== 'function') throw Error('Configure a finite lease and deployed-release reader');
  }
  catalog(): readonly TriggerCapability[] {
    return this.definitions.map(({ id, label, kind, schedule }) => ({ id, label, kind, ...(schedule ? { everyMs: schedule.everyMs } : {}) }));
  }
  private definition(id: string): TriggerDefinition {
    const value = this.definitions.find(definition => definition.id === id); if (!value) throw Error('Choose a registered trigger ID'); return value;
  }
  private async load(definition: TriggerDefinition): Promise<TriggerJobState> {
    const digest = fingerprint(definition), state = await this.options.store.load(definition.id) ?? { version: 1, kind: 'trigger-job', definition, definitionDigest: digest,
      ...(definition.schedule ? { nextDueAt: definition.schedule.startsAt } : {}), invocations: [] } as TriggerJobState;
    if (state.definitionDigest !== digest || canonical(state.definition) !== canonical(definition)) throw Error('Trigger configuration changed; register a new durable job ID');
    for (const run of state.invocations) {
      if (run.request && (run.request.invocationId !== run.id || run.request.suiteId !== definition.suiteId || run.request.suiteDigest !== definition.suiteDigest
        || run.request.stageId !== definition.stageId || canonical(run.request.target) !== canonical(definition.target))) throw Error('Trigger invocation differs from its registered binding');
      if (run.result && (!run.request || canonical(run.result.request) !== canonical(run.request) || run.result.runnerId !== definition.runnerId
        || run.result.status !== run.status)) throw Error('Trigger result differs from its invocation');
    }
    return readTriggerJob(state);
  }
  snapshot(id: string): Promise<TriggerJobState> { return this.load(this.definition(id)); }
  /** Tick all registered interval jobs once. A late tick either coalesces one run or records a skip. */
  async tick(): Promise<{ id: string; result: TriggerDispatch }[]> {
    const results: { id: string; result: TriggerDispatch }[] = [];
    for (const definition of this.definitions.filter(item => item.kind === 'interval')) results.push({ id: definition.id, result: await this.dispatch(definition.id) });
    return results;
  }
  async dispatch(id: string, input?: TriggerSignal): Promise<TriggerDispatch> {
    const definition = this.definition(id), signal = input === undefined ? undefined : readTriggerSignal(input), now = time(this.clock());
    const reserved = await this.options.store.withLock(id, async (): Promise<TriggerDispatch | { invocation: TriggerInvocation; candidate: TriggerCandidate }> => {
      const state = structuredClone(await this.load(definition));
      const active = state.invocations.find(run => run.status === 'running');
      if (active) {
        if (active.lease!.expiresAt <= now) { active.status = 'incomplete'; delete active.lease; await this.options.store.save(state); return { status: 'incomplete', invocation: active }; }
        return { status: 'overlap', invocation: active };
      }
      // An expired/crashed invocation has an uncertain tool outcome. Inspection is required before reusing this job.
      if (state.invocations.some(run => run.status === 'incomplete')) return { status: 'incomplete', invocation: state.invocations.find(run => run.status === 'incomplete')! };
      const candidate = await this.adapters.get(definition.adapterId)!.prepare({ definition, now, signal, nextDueAt: state.nextDueAt });
      if (!candidate) return { status: 'not-due' };
      if (typeof candidate.dedupeKey !== 'string' || !candidate.dedupeKey || candidate.dedupeKey.length > 512 || typeof candidate.dispatch !== 'boolean'
        || !['after-deploy','rollout-analysis','recovery','scheduled','manual'].includes(candidate.reason)) throw Error('Invalid trigger adapter candidate');
      time(candidate.scheduledAt); if (candidate.nextDueAt !== undefined) time(candidate.nextDueAt);
      const previous = state.invocations.find(run => run.dedupeKey === candidate.dedupeKey);
      if (previous) { await this.verifyResult(definition, previous); return { status: 'duplicate', invocation: previous }; }
      if (state.invocations.length >= 10_000) throw Error('Archive full trigger history before dispatch');
      const invocation: TriggerInvocation = { id: randomUUID(), dedupeKey: candidate.dedupeKey, scheduledAt: candidate.scheduledAt, dispatchedAt: now,
        status: candidate.dispatch ? 'running' : 'skipped', ...(candidate.dispatch ? { lease: { token: randomUUID(), expiresAt: time(now + this.leaseMs) } } : {}) };
      state.invocations.push(invocation); if (candidate.nextDueAt !== undefined) state.nextDueAt = candidate.nextDueAt;
      await this.options.store.save(state); // Intent and dedupe key are synced before current-release read or tool execution.
      if (!candidate.dispatch) return { status: 'skipped', invocation };
      return { invocation, candidate };
    }).catch(error=>{if(error instanceof TriggerStoreBusyError)return {status:'overlap' as const};throw error;});
    if ('status' in reserved) return reserved;
    return this.execute(definition, reserved.invocation, reserved.candidate);
  }
  private workflow(definition: TriggerDefinition, run: TriggerInvocation): CheckWorkflow {
    if (!run.request) throw Error('Trigger request is not retained');
    return new CheckWorkflow({ runner: this.checks.get(definition.runnerId)!, request: run.request,
      store: new FileCheckStore(this.options.store.runDirectory(definition.id, run.id)) });
  }
  private async verifyResult(definition: TriggerDefinition, run: TriggerInvocation): Promise<void> {
    if (run.status !== 'passed' && run.status !== 'failed') return;
    const result = await this.workflow(definition, run).snapshot();
    if (canonical(result) !== canonical(run.result)) throw Error('Trigger ledger differs from retained native check evidence');
  }
  private async execute(definition: TriggerDefinition, reserved: TriggerInvocation, candidate: TriggerCandidate): Promise<TriggerDispatch> {
    let result: Awaited<ReturnType<CheckWorkflow['start']>> | undefined, request: CheckRequest | undefined;
    try {
      const current = await this.options.readCurrent(definition);
      if (!current) throw Error('The actual deployed release is unknown');
      request = readCheckRequest({ invocationId: reserved.id, suiteId: definition.suiteId, suiteDigest: definition.suiteDigest,
        releaseId: current.id, releaseDigest: current.digest, stageId: definition.stageId, target: definition.target, reason: candidate.reason });
      if (candidate.completion && (candidate.completion.releaseId !== current.id || candidate.completion.releaseDigest !== current.digest)) throw Error('Stage event is stale for the current deployed release');
      await this.options.store.withLock(definition.id, async () => {
        const state = structuredClone(await this.load(definition)), run = state.invocations.find(run => run.id === reserved.id)!;
        if (run.status !== 'running' || run.lease?.token !== reserved.lease!.token) throw Error('Invocation lease changed');
        run.request = request; await this.options.store.save(state);
      });
      result = await this.workflow(definition, { ...reserved, request }).start();
    } catch { /* No private provider errors or raw tool output enters public receipts. */ }
    return this.options.store.withLock(definition.id, async () => {
      const state = structuredClone(await this.load(definition)), run = state.invocations.find(run => run.id === reserved.id)!;
      if (run.status !== 'running' || run.lease?.token !== reserved.lease!.token) return { status: 'incomplete', invocation: run };
      run.status = result?.status === 'passed' ? 'passed' : result?.status === 'failed' ? 'failed' : 'incomplete';
      if (result) run.result = result; delete run.lease;
      await this.options.store.save(state); return { status: run.status, invocation: readTriggerJob(state).invocations.find(item => item.id === run.id)! };
    });
  }
}

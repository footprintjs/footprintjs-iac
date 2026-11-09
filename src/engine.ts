import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { CombinedRecorder } from 'footprintjs';
import { buildPlan } from './planner.ts';
import { assertExecutableGraph } from './graph/validation.ts';
import { ReconcileStrategy } from './strategies.ts';
import { createApplyChart } from './execution/create-apply-chart.ts';
import { createOperationExecutor } from './execution/execute-operation.ts';
import { ExecutionPersistence } from './execution/persistence.ts';
import { INTERNAL_CONTROL_RECORDER_ID, runApplyChart } from './execution/run-apply-chart.ts';
import { concurrencyLimit } from './execution/schedule.ts';
import type { ExecutionFailure } from './execution/types.ts';
import type { FailureStrategy, Plan, ResourceAdapter, Stack, StateStore } from './types.ts';

export interface ApplyResult {
  ok: boolean;
  runId: string;
  plan: Plan;
  evidencePath: string;
  tracePath?: string;
  /** Best-effort runtime evidence, separate from the durable operation journal. */
  traceStatus?: { entries: number; failed: number; flushed: boolean; error?: string };
  failure: ExecutionFailure | null;
  results: Record<string, unknown>;
}

export class InfraEngine {
  private readonly adapters: Map<string, ResourceAdapter>;
  private readonly store: StateStore;
  private readonly strategy: FailureStrategy;
  private readonly traceDirectory: string | undefined;
  private readonly maxConcurrency: number;
  private readonly recorders: readonly CombinedRecorder[];

  constructor(options: { adapters: ResourceAdapter[]; store: StateStore; strategy?: FailureStrategy; traceDirectory?: string; maxConcurrency?: number; recorders?: CombinedRecorder[] }) {
    this.adapters = new Map(options.adapters.map(adapter => [adapter.name, adapter]));
    if (this.adapters.size !== options.adapters.length) throw new Error('Duplicate provider adapter names');
    this.store = options.store;
    this.strategy = options.strategy ?? new ReconcileStrategy();
    this.traceDirectory = options.traceDirectory === undefined ? undefined : resolve(options.traceDirectory);
    this.maxConcurrency = concurrencyLimit(options.maxConcurrency);
    this.recorders = [...(options.recorders ?? [])];
    if (new Set(this.recorders.map(recorder => recorder.id)).size !== this.recorders.length) throw new Error('Duplicate deployment recorder IDs');
    if (this.recorders.some(recorder => recorder.id === INTERNAL_CONTROL_RECORDER_ID)) throw new Error('The internal control recorder ID is reserved');
  }

  async plan(stack: Stack, options: { prune?: boolean } = {}): Promise<Plan> {
    assertExecutableGraph(stack); // Reject accessors before cloning recognized graph artifacts.
    const requested = structuredClone(stack);
    assertExecutableGraph(requested);
    return buildPlan(requested, await this.store.load(requested.name), this.adapters, options);
  }

  async apply(stack: Stack, options: { prune?: boolean } = {}): Promise<ApplyResult> {
    assertExecutableGraph(stack); // Reject accessors before cloning recognized graph artifacts.
    const requested = structuredClone(stack);
    assertExecutableGraph(requested); // Graph/boundary admission precedes every provider observation.
    return this.store.withLock(requested.name, async () => {
      const state = await this.store.load(requested.name);
      const plan = await buildPlan(requested, state, this.adapters, options);
      const persistence = new ExecutionPersistence(this.store);
      state.providerScopes = Object.fromEntries([...this.adapters].filter(([, adapter]) => adapter.scope !== undefined).map(([name, adapter]) => [name, adapter.scope!]));
      await persistence.save(state);
      const runId = randomUUID();
      const results: Record<string, unknown> = {};
      const execute = createOperationExecutor({ adapters: this.adapters, state, runId, strategy: this.strategy, persistence });
      const chart = createApplyChart(plan, execute, results, this.maxConcurrency, runId);
      const recorded = await runApplyChart(chart, runId, this.traceDirectory, this.recorders);
      const graph = (requested as Stack & { kind?: unknown }).kind === 'infra-graph' ? requested : undefined;
      const evidencePath = await this.store.saveEvidence(runId, {
        version: 1, runId, stack: requested.name, ...recorded,
        ...(graph ? { graph } : {}),
      });
      const failure = recorded.snapshot.sharedState.failure as ExecutionFailure | null;
      return { ok: !failure, runId, plan, evidencePath, failure, results,
        ...(recorded.tracePath ? { tracePath: recorded.tracePath, traceStatus: recorded.traceStatus } : {}) };
    });
  }
}

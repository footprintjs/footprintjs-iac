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
import { INTERNAL_CHART_RECORDER_ID } from './execution/chart-observer.ts';
import { readDeploymentChart, type DeploymentChartObserver } from './progress/chart.ts';
import type { ExecutionFailure } from './execution/types.ts';
import type { FailureStrategy, Plan, ResourceAdapter, Stack, StateStore } from './types.ts';
import { fingerprintPlan } from './master/plan.ts';

export interface ApplyResult {
  ok: boolean;
  runId: string;
  plan: Plan;
  evidencePath: string;
  tracePath?: string;
  /** Best-effort runtime evidence, separate from the durable operation journal. */
  traceStatus?: { entries: number; failed: number; flushed: boolean; error?: string };
  chartStatus?: { published: boolean; failed: number };
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
  private readonly chartObservers: readonly DeploymentChartObserver[];

  constructor(options: { adapters: ResourceAdapter[]; store: StateStore; strategy?: FailureStrategy; traceDirectory?: string; maxConcurrency?: number; recorders?: CombinedRecorder[]; chartObservers?: DeploymentChartObserver[] }) {
    this.adapters = new Map(options.adapters.map(adapter => [adapter.name, adapter]));
    if (this.adapters.size !== options.adapters.length) throw new Error('Duplicate provider adapter names');
    this.store = options.store;
    this.strategy = options.strategy ?? new ReconcileStrategy();
    this.traceDirectory = options.traceDirectory === undefined ? undefined : resolve(options.traceDirectory);
    this.maxConcurrency = concurrencyLimit(options.maxConcurrency);
    this.recorders = [...(options.recorders ?? [])];
    if (new Set(this.recorders.map(recorder => recorder.id)).size !== this.recorders.length) throw new Error('Duplicate deployment recorder IDs');
    if (this.recorders.some(recorder => [INTERNAL_CONTROL_RECORDER_ID, INTERNAL_CHART_RECORDER_ID].includes(recorder.id))) throw new Error('The internal recorder ID is reserved');
    this.chartObservers = [...(options.chartObservers ?? [])];
    if (this.chartObservers.some(observer => !observer || typeof observer.id !== 'string' || !observer.id.trim() || typeof observer.onChart !== 'function')) throw new Error('A deployment chart observer needs an ID and onChart method');
    if (new Set(this.chartObservers.map(observer => observer.id)).size !== this.chartObservers.length) throw new Error('Duplicate deployment chart observer IDs');
  }

  async plan(stack: Stack, options: { prune?: boolean } = {}): Promise<Plan> {
    assertExecutableGraph(stack); // Reject accessors before cloning recognized graph artifacts.
    const requested = structuredClone(stack);
    assertExecutableGraph(requested);
    return buildPlan(requested, await this.store.load(requested.name), this.adapters, options);
  }

  async apply(stack: Stack, options: { prune?: boolean; expectedPlanDigest?: string } = {}): Promise<ApplyResult> {
    const expected = Object.getOwnPropertyDescriptor(options, 'expectedPlanDigest');
    if ((expected && !('value' in expected)) || (!expected && 'expectedPlanDigest' in options)) throw new Error('Expected plan digest must be own data');
    const expectedPlanDigest = expected?.value as string | undefined;
    if (expectedPlanDigest !== undefined && (typeof expectedPlanDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPlanDigest))) throw new Error('Invalid expected plan digest');
    assertExecutableGraph(stack); // Reject accessors before cloning recognized graph artifacts.
    const requested = structuredClone(stack);
    assertExecutableGraph(requested); // Graph/boundary admission precedes every provider observation.
    return this.store.withLock(requested.name, async () => {
      const state = await this.store.load(requested.name);
      const plan = await buildPlan(requested, state, this.adapters, options);
      if (expectedPlanDigest !== undefined && fingerprintPlan(plan) !== expectedPlanDigest) {
        throw new Error('The reviewed plan is stale; inspect the current system and review again');
      }
      const persistence = new ExecutionPersistence(this.store);
      state.providerScopes = Object.fromEntries([...this.adapters].filter(([, adapter]) => adapter.scope !== undefined).map(([name, adapter]) => [name, adapter.scope!]));
      await persistence.save(state);
      const runId = randomUUID();
      const results: Record<string, unknown> = {};
      const execute = createOperationExecutor({ adapters: this.adapters, state, runId, strategy: this.strategy, persistence,
        reviewedPlan: expectedPlanDigest !== undefined });
      const graph = (requested as Stack & { kind?: unknown }).kind === 'infra-graph' ? requested : undefined;
      const built = createApplyChart(plan, execute, results, this.maxConcurrency, runId);
      const deploymentChart = readDeploymentChart({ version: 1, runId, stack: requested.name,
        ...(graph ? { graphDigest: (graph as Stack & { digest: string }).digest } : {}),
        structure: built.chart.buildTimeStructure, resources: built.resources });
      const recorded = await runApplyChart(built.chart, runId, this.traceDirectory, this.recorders, { chart: deploymentChart, observers: this.chartObservers });
      const evidencePath = await this.store.saveEvidence(runId, {
        version: 1, runId, stack: requested.name, ...recorded,
        ...(graph ? { graph } : {}),
      });
      const failure = recorded.snapshot.sharedState.failure as ExecutionFailure | null;
      return { ok: !failure, runId, plan, evidencePath, failure, results, chartStatus: recorded.chartStatus,
        ...(recorded.tracePath ? { tracePath: recorded.tracePath, traceStatus: recorded.traceStatus } : {}) };
    });
  }
}

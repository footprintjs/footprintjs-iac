import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { FlowChartExecutor, type CombinedRecorder } from 'footprintjs';
import { fileSink } from 'footprintjs/sinks';
import { controlDepRecorder } from 'footprintjs/trace';
import { canonical, fingerprint } from '../util.ts';
import { readCheckRequest } from './data.ts';
import { readCheckExecution } from './state.ts';
import { CheckRunnerRegistry } from './registry.ts';
import { FileCheckStore } from './store.ts';
import { createCheckChart } from './create-check-chart.ts';
import { recordedCheckResult } from './stages.ts';
import { loadCheckRecording } from './recording.ts';
import type { CheckExecutionState, CheckRequest, CheckRunner } from './types.ts';

/** One immutable finite run, used by release gates and scheduled monitoring alike. */
export class CheckWorkflow {
  private readonly request: CheckRequest; private readonly registry: CheckRunnerRegistry; private readonly bindingDigest: string;
  private readonly runnerId: string; private readonly store: FileCheckStore; private readonly recorders: readonly CombinedRecorder[];
  constructor(options: { runner: CheckRunner; request: CheckRequest; store: FileCheckStore; recorders?: readonly CombinedRecorder[] }) {
    this.request = readCheckRequest(options.request); this.registry = new CheckRunnerRegistry([options.runner]);
    this.runnerId = options.runner.id; this.store = options.store; this.recorders = options.recorders ?? [];
    if (!this.registry.catalog()[0]!.suites.some(suite => suite.id === this.request.suiteId && suite.digest === this.request.suiteDigest)) throw Error('Choose a registered immutable suite');
    this.bindingDigest = fingerprint({ runnerId: this.runnerId, request: this.request });
  }
  async snapshot(): Promise<CheckExecutionState> {
    const state = await this.store.load() ?? { version: 1, kind: 'check-execution', runnerId: this.runnerId,
      request: this.request, bindingDigest: this.bindingDigest, status: 'idle' } as CheckExecutionState;
    if (state.bindingDigest !== this.bindingDigest || canonical(state.request) !== canonical(this.request) || state.runnerId !== this.runnerId) throw Error('Check binding changed; use a new invocation');
    if (state.status === 'passed' || state.status === 'failed') {
      if (dirname(resolve(state.recording!.evidencePath)) !== this.store.directory || dirname(resolve(state.recording!.tracePath)) !== this.store.directory) throw Error('Check receipt left its bound store');
      const recording = await loadCheckRecording(state.recording!.evidencePath, { runId: state.recording!.runId, bindingDigest: this.bindingDigest });
      const shared = (recording.snapshot as { sharedState?: Record<string, unknown> }).sharedState;
      if (!shared || shared.bindingDigest !== this.bindingDigest || canonical(shared.request) !== canonical(this.request)
        || canonical(shared.result) !== canonical(recordedCheckResult(state.result!))) throw Error('Check ledger differs from its native recording');
    }
    return readCheckExecution(state);
  }
  start(): Promise<CheckExecutionState> {
    return this.store.withLock(async () => {
      const loaded = await this.snapshot();
      if (loaded.status === 'passed' || loaded.status === 'failed') return loaded;
      if (loaded.status !== 'idle') throw Error('This invocation has an uncertain outcome; inspect evidence before another invocation');
      const state = structuredClone(loaded); state.status = 'running'; await this.store.save(state);
      return this.execute(state);
    });
  }
  private async execute(state: CheckExecutionState): Promise<CheckExecutionState> {
    const identity = randomUUID(), evidencePath = join(this.store.directory, identity + '.json'), tracePath = join(this.store.directory, identity + '.jsonl');
    const chart = createCheckChart({ state, registry: this.registry, persist: () => this.store.save(state) });
    const control = controlDepRecorder({ id: 'iac-check-control' });
    let sink: ReturnType<typeof fileSink> | undefined, executor: FlowChartExecutor | undefined, executionFailed = false, captureFailed = false;
    try {
      sink = fileSink(tracePath);
      executor = new FlowChartExecutor(chart, { readTracking: 'full', writeProvenance: 'reads-prefix', sink: { adapter: sink, onFailure: 'fail', flush: 'auto' } });
      executor.enableNarrative(); executor.attachCombinedRecorder(control);
      for (const recorder of this.recorders) executor.attachCombinedRecorder(recorder);
      await executor.run();
    } catch { executionFailed = true; }
    finally { if (sink) try { await sink.close(); } catch { captureFailed = true; } }
    if (!executor) { state.status = 'incomplete'; await this.store.save(state); return readCheckExecution(state); }
    const snapshot = executor.getSnapshot(), controlDeps: Record<string, unknown> = {};
    for (const commit of snapshot.commitLog) if (commit.runtimeStageId) { const entry = control.asLookup()(commit.runtimeStageId); if (entry) controlDeps[commit.runtimeStageId] = entry; }
    captureFailed ||= (snapshot.sink?.failed ?? 0) > 0;
    const status = !state.result || captureFailed || executionFailed && state.result.status === 'passed' ? 'incomplete' : state.result.status === 'passed' ? 'passed' : 'failed';
    try {
      await this.store.writeJson(evidencePath, { version: 1, kind: 'check-native-evidence', runId: snapshot.runId,
        bindingDigest: this.bindingDigest, runnerId: this.runnerId, request: this.request,
        snapshot, structure: chart.buildTimeStructure, controlDeps, decisions: control.getDecisions(), narrative: executor.getNarrativeEntries(), tracePath,
        traceStatus: { entries: snapshot.sink?.entries ?? 0, failed: (snapshot.sink?.failed ?? 0) + (captureFailed ? 1 : 0), flushed: !captureFailed }, status,
        limitations: ['Native stages record host-observed tool outcomes. Tool internals and remote application causality require their own traces. Secret values, raw reports and command configuration are omitted.'] });
    } catch { captureFailed = true; }
    state.recording = { runId: snapshot.runId!, evidencePath, tracePath, complete: !captureFailed && status !== 'incomplete' };
    state.status = captureFailed ? 'incomplete' : status;
    await this.store.save(state); return readCheckExecution(state);
  }
}

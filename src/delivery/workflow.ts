import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FlowChartExecutor, type CombinedRecorder, type EmitEvent } from 'footprintjs';
import { fileSink } from 'footprintjs/sinks';
import { controlDepRecorder } from 'footprintjs/trace';
import { canonical, fingerprint } from '../util.ts';
import { createDeliveryChart } from './create-delivery-chart.ts';
import { readDeliveryDefinition, readDeliveryState } from './data.ts';
import { loadDeliveryRecording } from './recording.ts';
import { recordedDeliveryDefinition, recordedDeliveryResult } from './summary.ts';
import { FileDeliveryStore } from './store.ts';
import { DELIVERY_EVENT, DELIVERY_STAGE_IDS, type DeliveryAdapters, type DeliveryDefinition, type DeliveryEvent, type DeliveryState } from './types.ts';

export interface DeliveryWorkflowOptions {
  definition: DeliveryDefinition; store: FileDeliveryStore; adapters: DeliveryAdapters; recorders?: readonly CombinedRecorder[];
}
const labels = ['Choose exact version', 'Get code', 'Build package', 'Store package', 'Review changes', 'Deploy changes', 'Check application'];
function initialState(definition: DeliveryDefinition, definitionDigest: string): DeliveryState {
  return { version: 1, kind: 'delivery-state', definition, definitionDigest, executionId: null, status: 'idle',
    stages: DELIVERY_STAGE_IDS.map((id, index) => ({ id, label: labels[index]!, status: 'pending' })), events: [], results: {}, recordings: [] };
}
function adapters(input: DeliveryAdapters): DeliveryAdapters {
  const contracts = { source: ['resolve', 'fetch'], build: ['build'], artifacts: ['publish'], deployment: ['plan', 'deploy', 'verify'] } as const;
  const result: Record<string, unknown> = {};
  for (const [key, methods] of Object.entries(contracts)) {
    const adapter = input?.[key as keyof DeliveryAdapters] as unknown as Record<string, unknown> | undefined;
    if (!adapter || methods.some(method => typeof adapter[method] !== 'function')) throw Error('Configure each required delivery adapter');
    result[key] = Object.freeze(Object.fromEntries(methods.map(method => [method, (adapter[method] as Function).bind(adapter)])));
  }
  return result as unknown as DeliveryAdapters;
}

/** One immutable delivery attempt. Reopening a completed result never repeats effects. */
export class DeliveryWorkflow {
  private readonly definition: DeliveryDefinition;
  private readonly definitionDigest: string;
  private readonly options: DeliveryWorkflowOptions;
  private readonly listeners = new Set<(state: DeliveryState) => void>();
  constructor(options: DeliveryWorkflowOptions) {
    this.definition = readDeliveryDefinition(options.definition); this.definitionDigest = fingerprint(this.definition);
    this.options = { ...options, definition: this.definition, adapters: adapters(options.adapters) };
  }
  async snapshot(): Promise<DeliveryState> { return this.load(); }
  subscribe(listener: (state: DeliveryState) => void): () => void {
    if (typeof listener !== 'function') throw Error('A delivery listener must be callable');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  start(): Promise<DeliveryState> {
    return this.options.store.withLock(async () => {
      const loaded = await this.load();
      if (loaded.status === 'passed') return loaded;
      if (loaded.status !== 'idle') throw Error('This delivery already started. Inspect its retained or uncertain outcome; use a new immutable delivery for another attempt.');
      const state = structuredClone(loaded); state.executionId = randomUUID(); state.status = 'running';
      await this.options.store.save(state); this.publish(state);
      return this.execute(state);
    });
  }
  private async load(): Promise<DeliveryState> {
    const state = await this.options.store.load() ?? initialState(this.definition, this.definitionDigest);
    if (state.definitionDigest !== this.definitionDigest || canonical(state.definition) !== canonical(this.definition)) throw Error('Delivery source, recipe, configuration or target changed; use a new bound delivery');
    if (state.status === 'passed') {
      const receipt = state.recordings[0]!;
      const recording = await loadDeliveryRecording(receipt.evidencePath, { runId: receipt.runId, definitionDigest: this.definitionDigest, executionId: state.executionId! });
      const shared = (recording.snapshot as { sharedState?: Record<string, unknown> }).sharedState;
      if (!shared || canonical(shared.definition) !== canonical(recordedDeliveryDefinition(this.definition))
        || Object.keys(state.results).some(key => canonical(shared[key]) !== canonical(recordedDeliveryResult(key as keyof typeof state.results, state.results)))) {
        throw Error('Completed delivery receipts differ from their retained native recording');
      }
    }
    return readDeliveryState(state);
  }
  private publish(state: DeliveryState): void {
    const detached = readDeliveryState(state);
    for (const listener of this.listeners) try { listener(detached); } catch { /* Viewers cannot change delivery execution. */ }
  }
  private async execute(state: DeliveryState): Promise<DeliveryState> {
    const store = this.options.store, identity = randomUUID();
    const evidencePath = join(store.directory, identity + '.json'), tracePath = join(store.directory, identity + '.jsonl');
    const chart = createDeliveryChart({ definition: this.definition, definitionDigest: this.definitionDigest,
      executionId: state.executionId!, adapters: this.options.adapters, results: state.results,
      persist: async () => { await store.save(state); this.publish(state); } });
    const progress: CombinedRecorder = { id: 'iac-delivery-progress', onEmit: event => this.recordEvent(state, event),
      toSnapshot: () => ({ name: 'Application delivery', data: { events: state.events }, description: 'Recorded source, package, reviewed changes and measured verification.' }) };
    const control = controlDepRecorder({ id: 'iac-delivery-control' });
    let sink: ReturnType<typeof fileSink> | undefined, executor: FlowChartExecutor | undefined;
    let failed = false, captureFailed = false;
    try {
      sink = fileSink(tracePath);
      executor = new FlowChartExecutor(chart, { readTracking: 'full', writeProvenance: 'reads-prefix', sink: { adapter: sink, onFailure: 'fail', flush: 'auto' } });
      executor.enableNarrative(); executor.attachCombinedRecorder(progress); executor.attachCombinedRecorder(control);
      for (const recorder of this.options.recorders ?? []) executor.attachCombinedRecorder(recorder);
      await executor.run();
    } catch { failed = true; }
    finally { if (sink) try { await sink.close(); } catch { captureFailed = true; } }
    if (!executor) {
      state.status = 'incomplete'; state.error = 'Native recording could not start. No delivery adapter was started.';
      await store.save(state); this.publish(state); return readDeliveryState(state);
    }
    const snapshot = executor.getSnapshot(), controlDeps: Record<string, unknown> = {};
    for (const commit of snapshot.commitLog) if (commit.runtimeStageId) { const entry = control.asLookup()(commit.runtimeStageId); if (entry) controlDeps[commit.runtimeStageId] = entry; }
    captureFailed ||= (snapshot.sink?.failed ?? 0) > 0;
    const complete = state.stages.every(stage => stage.status === 'passed') && state.results.verification?.ok === true;
    const recordedFailure = state.stages.some(stage => stage.status === 'failed');
    const status = captureFailed || (failed || !complete) && !recordedFailure ? 'incomplete' : recordedFailure ? 'failed' : 'passed';
    const recording = { runId: snapshot.runId!, evidencePath, tracePath, status } as const;
    try {
      await store.writeJson(evidencePath, { version: 1, kind: 'delivery-native-evidence', runId: snapshot.runId, stack: this.definition.id,
        definitionDigest: this.definitionDigest, executionId: state.executionId, snapshot, structure: chart.buildTimeStructure,
        controlDeps, decisions: control.getDecisions(), narrative: executor.getNarrativeEntries(), tracePath,
        traceStatus: { entries: snapshot.sink?.entries ?? 0, failed: (snapshot.sink?.failed ?? 0) + (captureFailed ? 1 : 0), flushed: !captureFailed }, status,
        limitations: ['Host-only source locations and adapter metadata are omitted from native recording. External build and provider internals require their own evidence.'] });
    } catch { captureFailed = true; }
    state.recordings.push({ ...recording, status: captureFailed ? 'incomplete' : status });
    state.status = captureFailed ? 'incomplete' : status;
    if (state.status !== 'passed') state.error = captureFailed
      ? 'Native capture could not be fully retained. Inspect provider outcomes before another attempt.'
      : 'A delivery stage did not confirm success. Its failed result and recording are retained.';
    await store.save(state); this.publish(state); return readDeliveryState(state);
  }
  private recordEvent(state: DeliveryState, event: EmitEvent): void {
    if (event.name !== DELIVERY_EVENT) return;
    const value = event.payload as Partial<DeliveryEvent>;
    if (!value || value.executionId !== state.executionId || !DELIVERY_STAGE_IDS.includes(value.stageId!)
      || !['running', 'passed', 'failed'].includes(value.status ?? '') || !Number.isFinite(event.timestamp)) return;
    const item: DeliveryEvent = { sequence: state.events.length + 1, executionId: state.executionId!, stageId: value.stageId!,
      status: value.status!, timestamp: event.timestamp, runtimeStageId: event.runtimeStageId };
    state.events.push(item); state.stages = state.stages.map(stage => stage.id === item.stageId ? { ...stage, status: item.status } : stage);
  }
}

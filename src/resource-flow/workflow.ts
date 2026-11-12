import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FlowChartExecutor, type CombinedRecorder, type FlowchartCheckpoint, type EmitEvent } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';
import { fileSink } from 'footprintjs/sinks';
import { canonical, fingerprint } from '../util.ts';
import { createResourceFlowChart } from './create-resource-flow-chart.ts';
import { readConnectionDetails, readConnectionProfileChoices, readFlowReceipt, readResourceFlowDefinition,
  readResourceFlowState, readResourceHandle, readVerificationResult, readResourceFlowResumeInput, readResourceFlowFailure } from './data.ts';
import type { ResourceFlowScope } from './scope.ts';
import { FileResourceFlowStore, type StoredResourceFlow } from './store.ts';
import { RESOURCE_FLOW_EVENT, type ConnectionProfileChoice, type ResourceFlowAdapters, type ResourceFlowDefinition,
  type ResourceFlowEvent, type ResourceFlowSegment, type ResourceFlowStageId, type ResourceFlowState } from './types.ts';

export interface ResourceFlowOptions {
  definition: ResourceFlowDefinition; store: FileResourceFlowStore; profiles: readonly ConnectionProfileChoice[];
  adapters: ResourceFlowAdapters; recorders?: readonly CombinedRecorder[];
}
function initialState(definition: ResourceFlowDefinition, definitionDigest: string): ResourceFlowState {
  return { version: 1, kind: 'resource-flow-state', definitionDigest, ...definition, executionId: null, status: 'idle',
    stages: [{ id: 'acquire', label: definition.mode === 'create' ? 'Create resource' : 'Find existing resource', status: 'pending' },
      { id: 'details', label: 'Connection details', status: 'pending' }, { id: 'connect', label: 'Connect application', status: 'pending' },
      { id: 'verify', label: 'Verify connection and access', status: 'pending' }], events: [], segments: [] };
}
/** Fixed host composition, one durable execution, and native FootPrint segments joined across a human wait. */
export class ResourceFlowWorkflow {
  private readonly definition: ResourceFlowDefinition;
  private readonly definitionDigest: string;
  private readonly profiles: ConnectionProfileChoice[];
  private readonly options: ResourceFlowOptions;
  private readonly listeners = new Set<(state: ResourceFlowState) => void>();
  constructor(options: ResourceFlowOptions) {
    this.definition = readResourceFlowDefinition(options.definition);
    this.profiles = readConnectionProfileChoices(options.profiles);
    this.definitionDigest = fingerprint({ definition: this.definition, profiles: this.profiles });
    if (!options.adapters || ['find', 'resolveDetails', 'validate', 'connect', 'verify'].some(key => typeof options.adapters[key as keyof ResourceFlowAdapters] !== 'function')
      || (this.definition.mode === 'create' && typeof options.adapters.create !== 'function')) throw Error('Configure the required resource flow adapters');
    this.options = { ...options, definition: this.definition, profiles: this.profiles,
      adapters: Object.fromEntries(['create', 'find', 'resolveDetails', 'validate', 'connect', 'verify'].flatMap(key => {
        const value = options.adapters[key as keyof ResourceFlowAdapters]; return value ? [[key, value.bind(options.adapters)]] : [];
      })) as unknown as ResourceFlowAdapters };
  }
  async snapshot(): Promise<ResourceFlowState> { return readResourceFlowState((await this.load()).state); }
  subscribe(listener: (state: ResourceFlowState) => void): () => void {
    if (typeof listener !== 'function') throw Error('A resource flow listener must be callable');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  start(): Promise<ResourceFlowState> {
    return this.options.store.withLock(async () => {
      const envelope = await this.load();
      if (envelope.state.status !== 'idle') throw Error('This resource flow already started; use its exact pending pause or inspect its retained result');
      const state = structuredClone(envelope.state); state.executionId = randomUUID(); state.status = 'running';
      await this.options.store.save({ version: 1, state }); this.publish(state);
      return this.execute(state);
    });
  }
  resume(input: { pauseToken: string; profileId: string }): Promise<ResourceFlowState> {
    return this.options.store.withLock(async () => {
      input = readResourceFlowResumeInput(input);
      const envelope = await this.load(), state = structuredClone(envelope.state), checkpoint = envelope.checkpoint;
      if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'pauseToken,profileId'
        || !/^[a-f0-9]{64}$/.test(input.pauseToken) || state.status !== 'paused' || state.pause?.token !== input.pauseToken
        || !this.profiles.some(profile => profile.id === input.profileId) || !checkpoint) throw Error('The pending pause or selected connection profile is stale');
      this.admitCheckpoint(checkpoint, state);
      delete state.pause; delete state.error; state.status = 'running';
      // Consume the one-use answer before re-entering native execution. A crash is retained, never replayed blindly.
      await this.options.store.save({ version: 1, state }); this.publish(state);
      return this.execute(state, checkpoint, input.profileId);
    });
  }
  private async load(): Promise<StoredResourceFlow> {
    const envelope = await this.options.store.load() ?? { version: 1 as const, state: initialState(this.definition, this.definitionDigest) };
    if (envelope.state.definitionDigest !== this.definitionDigest
      || canonical({ id: envelope.state.id, resourceId: envelope.state.resourceId, label: envelope.state.label, mode: envelope.state.mode, target: envelope.state.target, configurationDigest: envelope.state.configurationDigest }) !== canonical(this.definition)
      || (envelope.state.pause && canonical(envelope.state.pause.profiles) !== canonical(this.profiles))
      || (envelope.state.details && !this.profiles.some(profile => profile.id === envelope.state.details!.profileId))) {
      throw Error('Resource flow definition, profile catalog or target changed; the stored execution cannot be resumed');
    }
    return envelope;
  }
  private admitCheckpoint(checkpoint: FlowchartCheckpoint, state: ResourceFlowState): void {
    const shared = checkpoint.sharedState;
    const allowed = ['definition', 'definitionDigest', 'context', 'resource', 'validatedResource', 'details', 'connection', 'verification', 'awaitingProfile', 'selectedProfileId', 'error', 'progress:acquire', 'progress:details', 'progress:connect', 'progress:verify'];
    if (checkpoint.pausedStageId !== 'details' || checkpoint.pausedBy !== 'interrupt' || checkpoint.subflowPath.length !== 0
      || checkpoint.subflowStates && Object.keys(checkpoint.subflowStates).length !== 0
      || !shared || Object.keys(shared).some(key => !allowed.includes(key))
      || shared.definitionDigest !== this.definitionDigest || canonical(shared.definition) !== canonical(this.definition)
      || shared.awaitingProfile !== true || canonical(shared.resource) !== canonical(state.resource)
      || shared.details !== undefined || shared.connection !== undefined || shared.verification !== undefined || shared.selectedProfileId !== undefined || shared.error !== undefined || shared.failure !== undefined
      || shared['progress:connect'] !== undefined || shared['progress:verify'] !== undefined
      || (shared.context as { executionId?: string })?.executionId !== state.executionId
      || (shared.context as { definitionDigest?: string })?.definitionDigest !== this.definitionDigest
      || (shared.context as { operationId?: string })?.operationId !== fingerprint(state.executionId)
      || checkpoint.pausedExecution?.runId !== state.segments.at(-1)?.runId || state.segments.at(-1)?.status !== 'paused'
      || Object.keys(shared.context as object).sort().join(',') !== 'definitionDigest,executionId,operationId') throw Error('The checkpoint does not match this pending resource and definition');
    readResourceHandle(shared.resource);
    if (shared.validatedResource !== undefined) readResourceHandle(shared.validatedResource);
    for (const id of ['acquire', 'details']) {
      const progress = shared['progress:' + id] as { executionId?: string; stageId?: string; status?: string };
      if (!progress || Object.keys(progress).sort().join(',') !== 'executionId,stageId,status' || progress.executionId !== state.executionId
        || progress.stageId !== id || progress.status !== (id === 'acquire' ? 'passed' : 'waiting')) throw Error('The checkpoint progress differs from the paused resource flow');
    }
  }
  private publish(state: ResourceFlowState): void {
    const snapshot = readResourceFlowState(state);
    for (const listener of this.listeners) { try { listener(snapshot); } catch { /* Viewers cannot change execution. */ } }
  }
  private async execute(state: ResourceFlowState, checkpoint?: FlowchartCheckpoint, profileId?: string): Promise<ResourceFlowState> {
    const legId = randomUUID(), store = this.options.store;
    const tracePath = join(store.directory, legId + '.jsonl'), evidencePath = join(store.directory, legId + '.json');
    const recorder: CombinedRecorder = { id: 'iac-resource-flow-progress', onEmit: event => this.recordEvent(state, event),
      toSnapshot: () => ({ name: 'IaC resource lifecycle', data: { events: state.events }, description: 'Native create/find, connection details, configuration and verification stages.' }) };
    const persist = async (scope: ResourceFlowScope) => {
      for (const [key, reader] of [['resource', readResourceHandle], ['details', readConnectionDetails], ['connection', readFlowReceipt], ['verification', readVerificationResult], ['failure', readResourceFlowFailure]] as const) {
        const value = scope.getValue(key); if (value !== undefined) Object.assign(state, { [key]: reader(value) });
      }
      await store.save({ version: 1, state }); this.publish(state);
    };
    const chart = createResourceFlowChart({ definition: this.definition, definitionDigest: this.definitionDigest,
      executionId: state.executionId!, profiles: this.profiles, adapters: this.options.adapters, persist });
    let sink: ReturnType<typeof fileSink> | undefined;
    let executor: FlowChartExecutor | undefined;
    const control = controlDepRecorder({ id: 'iac-resource-flow-control' });
    let failed = false, captureFailed = false;
    try {
      sink = fileSink(tracePath);
      executor = new FlowChartExecutor(chart, { readTracking: 'full', writeProvenance: 'reads-prefix', sink: { adapter: sink, onFailure: 'fail', flush: 'auto' } });
      executor.enableNarrative(); executor.attachCombinedRecorder(recorder); executor.attachCombinedRecorder(control);
      for (const extra of this.options.recorders ?? []) executor.attachCombinedRecorder(extra);
      if (checkpoint) await executor.resume(checkpoint, { profileId }); else await executor.run();
    } catch { failed = true; }
    finally { if (sink) { try { await sink.close(); } catch { captureFailed = true; } } }
    if (!executor) {
      state.status = 'incomplete'; state.error = 'Native recording could not start; no adapter operation was started.';
      await store.save({ version: 1, state }); this.publish(state); return readResourceFlowState(state);
    }
    const snapshot = executor.getSnapshot(), paused = executor.isPaused(), nextCheckpoint = executor.getCheckpoint();
    const traceStatus = { entries: snapshot.sink?.entries ?? 0, failed: (snapshot.sink?.failed ?? 0) + (captureFailed ? 1 : 0),
      flushed: !captureFailed && (snapshot.sink?.failed ?? 0) === 0 };
    captureFailed ||= !traceStatus.flushed;
    const controlDeps: Record<string, unknown> = {};
    for (const commit of snapshot.commitLog) if (commit.runtimeStageId) {
      const dependency = control.asLookup()(commit.runtimeStageId); if (dependency) controlDeps[commit.runtimeStageId] = dependency;
    }
    const status: ResourceFlowSegment['status'] = captureFailed ? 'incomplete' : failed ? 'failed' : paused ? 'paused' : 'passed';
    const segment: ResourceFlowSegment = { runId: snapshot.runId!, evidencePath, tracePath, status,
      ...(checkpoint?.pausedExecution?.runId ? { resumedFromRunId: checkpoint.pausedExecution.runId } : {}) };
    try {
      await store.writeJson(evidencePath, { version: 1, stack: this.definition.id, runId: snapshot.runId, definition: this.definition,
        definitionDigest: this.definitionDigest, executionId: state.executionId, snapshot, structure: chart.buildTimeStructure,
        controlDeps, decisions: control.getDecisions(), narrative: executor.getNarrativeEntries(), tracePath, traceStatus, status,
        ...(checkpoint ? { resumedFrom: checkpoint.pausedExecution } : {}) });
    } catch { captureFailed = true; segment.status = 'incomplete'; }
    state.segments.push(segment);
    if (captureFailed) { state.status = 'incomplete'; state.error = 'Native capture could not be fully retained. Inspect resource outcomes before any further execution.'; }
    else if (failed) { state.status = 'failed'; state.error = 'A recorded resource lifecycle stage failed. Check its measured results and private adapter diagnostics.'; }
    else if (paused && nextCheckpoint) {
      state.status = 'paused'; state.pause = { token: randomBytes(32).toString('hex'), prompt: 'Choose a connection profile', profiles: this.profiles };
    } else if (state.stages.every(stage => stage.status === 'passed') && state.verification?.ok === true) state.status = 'passed';
    else { state.status = 'incomplete'; state.error = 'The native execution did not confirm every lifecycle stage.'; }
    const envelope: StoredResourceFlow = { version: 1, state,
      ...(state.status === 'paused' && nextCheckpoint ? { checkpoint: nextCheckpoint, checkpointDigest: fingerprint(nextCheckpoint) } : {}) };
    await store.save(envelope); this.publish(state); return readResourceFlowState(state);
  }
  private recordEvent(state: ResourceFlowState, event: EmitEvent): void {
    if (event.name !== RESOURCE_FLOW_EVENT) return;
    const value = event.payload as { executionId?: string; stageId?: ResourceFlowStageId; status?: ResourceFlowEvent['status'] };
    if (!value || value.executionId !== state.executionId || !state.stages.some(stage => stage.id === value.stageId)
      || !['running', 'waiting', 'passed', 'failed'].includes(value.status ?? '') || !Number.isFinite(event.timestamp)) return;
    const recorded: ResourceFlowEvent = { sequence: state.events.length + 1, executionId: state.executionId!, stageId: value.stageId!,
      status: value.status!, timestamp: event.timestamp, runtimeStageId: event.runtimeStageId };
    state.events.push(recorded); state.stages = state.stages.map(stage => stage.id === recorded.stageId ? { ...stage, status: recorded.status } : stage);
  }
}

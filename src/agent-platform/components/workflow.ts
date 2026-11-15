import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FlowChartExecutor, type CombinedRecorder } from 'footprintjs';
import { controlDepRecorder, topologyRecorder } from 'footprintjs/trace';
import { fileSink } from 'footprintjs/sinks';
import type { InfraGraph } from '../../graph/types.ts';
import { freeze } from '../../graph/data.ts';
import type { ResourceFlowSegment } from '../../resource-flow/types.ts';
import type { AgentDeployment } from '../types.ts';
import { readAgentDeployment } from '../data.ts';
import { AgentComponentsStore, type StoredAgentComponents } from './store.ts';
import { readAgentComponentGraph } from './declaration.ts';
import { createComponentWorkflow, componentState } from './child.ts';
import { createAgentComponentChart } from './create-component-chart.ts';
import { admitAgentComponentsRecording, COMPONENT_GRAPH_RECORDER } from './recording.ts';
import { componentOutcome } from './projection.ts';
import type { AgentComponentGraph, AgentComponentsState, AgentComponentsResumeInput, AgentComponentPorts, AgentComponentState } from './types.ts';

export interface AgentComponentsOptions {
 definition: AgentComponentGraph; deployment: AgentDeployment; graph: InfraGraph; directory: string;
 components: Readonly<Partial<Record<string, AgentComponentPorts>>>; maxConcurrency?: number;
}
/** Native component graph coordinator over independently recorded, durable resource lifecycles. */
export class AgentComponentsWorkflow {
 private readonly definition: AgentComponentGraph; private readonly deployment: AgentDeployment; private readonly store: AgentComponentsStore;
 private readonly maxConcurrency: number; private readonly children = new Map<string, ReturnType<typeof createComponentWorkflow>>();
 private readonly listeners = new Set<(state: AgentComponentsState) => void>();
 private live = false; private operation = false; private state?: AgentComponentsState;
 constructor(options: AgentComponentsOptions) {
  this.deployment = readAgentDeployment(options.deployment, options.graph); this.definition = readAgentComponentGraph(options.definition, this.deployment, options.graph);
  this.maxConcurrency = options.maxConcurrency ?? 4;
  if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1 || this.maxConcurrency > 16) throw Error('Choose bounded component concurrency');
  this.store = new AgentComponentsStore(options.directory);
  if (!options.components || Object.keys(options.components).some(id => !this.definition.components.some(value => value.id === id))) throw Error('Register only declared component adapters');
  for (const component of this.definition.components) {
   const ports = options.components[component.id]; if (component.selected === false) continue;
   if (!ports) throw Error('Register primitives for every selected component');
   const child = createComponentWorkflow(this.definition, component, this.deployment, options.graph, this.store.directory, ports);
   child.subscribe(readiness => { if (this.live) this.update(componentState(component.id, readiness, true)); });
   this.children.set(component.id, child);
  }
 }
 subscribe(listener: (state: AgentComponentsState) => void): () => void {
  if (typeof listener !== 'function') throw Error('Component observation listener must be callable'); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
 }
 private publish(): void { if (!this.state) return; const state = freeze(structuredClone(this.state)); for (const listener of this.listeners) { try { listener(state); } catch { /* Observation cannot affect native execution. */ } } }
 private update(value: AgentComponentState): void {
  if (!this.state) return; this.state = { ...this.state, components: this.state.components.map(component => component.id === value.id ? value : component) }; this.publish();
 }
 private async read(): Promise<{ ledger?: StoredAgentComponents; state: AgentComponentsState }> {
  const ledger = await this.store.load();
  if (ledger && (ledger.definitionDigest !== this.definition.digest || ledger.maxConcurrency !== this.maxConcurrency)) throw Error('Component graph, target, revision or execution policy changed');
  const components = await Promise.all(this.definition.components.map(async component => {
   if (component.selected === false) return { id: component.id, status: 'skipped' as const };
   if (this.live && this.state?.components.find(value => value.id === component.id)?.readiness) return structuredClone(this.state.components.find(value => value.id === component.id)!);
   return componentState(component.id, await this.children.get(component.id)!.snapshot(), false);
  }));
  const admitted = ledger ? await admitAgentComponentsRecording(this.definition, ledger, components, this.store.directory) : components;
  let status: AgentComponentsState['status'] = ledger?.status ?? (admitted.some(value => value.readiness) ? 'incomplete' : 'idle');
  if (status === 'running' && !this.live) status = 'incomplete';
  if (ledger && !['running', 'incomplete'].includes(ledger.status) && componentOutcome(admitted, this.definition) !== ledger.status) throw Error('Component state differs from its native outcome');
  return { ledger, state: freeze({ version: 1, kind: 'agent-components-state', definitionDigest: this.definition.digest, executionId: ledger?.executionId ?? null,
   status, ready: status === 'ready', components: admitted, segments: ledger?.segments ?? [] }) };
 }
 async snapshot(): Promise<AgentComponentsState> { return (await this.read()).state; }
 start(input?: { profileId?: string }): Promise<AgentComponentsState> { return this.exclusive(async () => {
  if (input && (Object.keys(input).some(key => key !== 'profileId') || input.profileId !== undefined && typeof input.profileId !== 'string')) throw Error('Choose a registered component profile');
  const loaded = await this.read(); if (loaded.state.status !== 'idle') throw Error('Component graph already started; inspect its exact retained result or pending pause');
  const ledger: StoredAgentComponents = { version: 1, definitionDigest: this.definition.digest, executionId: randomUUID(), status: 'running', maxConcurrency: this.maxConcurrency, segments: [] };
  await this.store.save(ledger); this.state = { ...loaded.state, executionId: ledger.executionId, status: 'running' }; this.publish();
  return this.execute(ledger, input?.profileId);
 }); }
 resume(input: AgentComponentsResumeInput): Promise<AgentComponentsState> { return this.exclusive(async () => {
  if (!input || Object.keys(input).sort().join(',') !== 'componentId,pauseToken,profileId' || typeof input.componentId !== 'string' || typeof input.pauseToken !== 'string' || typeof input.profileId !== 'string') throw Error('Choose the exact native component pause');
  const loaded = await this.read(), component = loaded.state.components.find(value => value.id === input.componentId);
  if (!loaded.ledger || loaded.state.status !== 'paused' || component?.status !== 'paused' || component.readiness?.flow.pause?.token !== input.pauseToken) throw Error('The component pause changed or is unavailable');
  const ledger = { ...loaded.ledger, status: 'running' as const };
  // Persist parent continuation intent before the child's one-use native resume can perform effects.
  await this.store.save(ledger); this.state = { ...loaded.state, status: 'running', ready: false }; this.publish();
  return this.execute(ledger, undefined, input);
 }); }
 private exclusive(work: () => Promise<AgentComponentsState>): Promise<AgentComponentsState> {
  if (this.operation) return Promise.reject(Error('A component graph operation is already running'));
  this.operation = true;
  return this.store.withLock(work).finally(() => { this.live = false; this.operation = false; });
 }
 private async execute(ledger: StoredAgentComponents, profileId?: string, resume?: AgentComponentsResumeInput): Promise<AgentComponentsState> {
  this.live = true;
  const run = async (id: string) => {
   const child = this.children.get(id)!;
   const readiness = resume?.componentId === id ? await child.resume({ pauseToken: resume.pauseToken, profileId: resume.profileId })
    : await child.start(profileId ? { profileId } : undefined);
   return componentState(id, readiness, true);
  };
  const resumedFromRunId = ledger.segments.at(-1)?.runId;
  const chart = createAgentComponentChart({ definition: this.definition, executionId: ledger.executionId, ...(resumedFromRunId ? { resumedFromRunId } : {}), ...(resume ? { resumeComponentId: resume.componentId } : {}), state: () => this.state!, run, update: value => this.update(value) }, this.maxConcurrency);
  const leg = randomUUID(), tracePath = join(this.store.directory, leg + '.jsonl'), evidencePath = join(this.store.directory, leg + '.json');
  const binding: CombinedRecorder = { id: COMPONENT_GRAPH_RECORDER, onEmit() {}, toSnapshot: () => ({ name: 'Agent component graph', data: { definition: this.definition, resumedFromRunId: resumedFromRunId ?? null } }) };
  const control = controlDepRecorder({ id: 'iac-agent-components-control' }), topology = topologyRecorder({ id: 'iac-agent-components-topology' });
  let sink: ReturnType<typeof fileSink> | undefined, executor: FlowChartExecutor | undefined, captureFailed = false, executionFailed = false;
  try {
   sink = fileSink(tracePath); executor = new FlowChartExecutor(chart, { readTracking: 'full', writeProvenance: 'reads-prefix', sink: { adapter: sink, onFailure: 'fail', flush: 'auto' } });
   executor.enableNarrative(); executor.attachCombinedRecorder(binding); executor.attachCombinedRecorder(control); executor.attachCombinedRecorder(topology);
   await executor.run();
  } catch { executionFailed = true; }
  finally { if (sink) { try { await sink.close(); } catch { captureFailed = true; } } }
  if (!executor) {
   const incomplete = { ...ledger, status: 'incomplete' as const }; await this.store.save(incomplete); this.state = { ...this.state!, status: 'incomplete', ready: false }; this.publish(); return freeze(this.state);
  }
  const snapshot = executor.getSnapshot(), traceStatus = { entries: snapshot.sink?.entries ?? 0, failed: (snapshot.sink?.failed ?? 0) + (captureFailed ? 1 : 0),
   flushed: !captureFailed && (snapshot.sink?.failed ?? 0) === 0 };
  captureFailed ||= !traceStatus.flushed || executionFailed;
  const controlDeps: Record<string, unknown> = {};
  for (const commit of snapshot.commitLog) if (commit.runtimeStageId) { const value = control.asLookup()(commit.runtimeStageId); if (value) controlDeps[commit.runtimeStageId] = value; }
  const segment: ResourceFlowSegment = { runId: snapshot.runId!, evidencePath, tracePath, status: captureFailed ? 'incomplete' : 'passed',
   ...(ledger.segments.length ? { resumedFromRunId: ledger.segments.at(-1)!.runId } : {}) };
  try { await this.store.writeJson(evidencePath, { version: 1, stack: this.definition.id, runId: snapshot.runId, definitionDigest: this.definition.digest,
   executionId: ledger.executionId, status: segment.status, snapshot, structure: chart.buildTimeStructure, controlDeps, decisions: control.getDecisions(),
   narrative: executor.getNarrativeEntries(), tracePath, traceStatus }); } catch { captureFailed = true; segment.status = 'incomplete'; }
  const status = captureFailed ? 'incomplete' : componentOutcome(this.state!.components, this.definition);
  const saved: StoredAgentComponents = { ...ledger, status, segments: [...ledger.segments, segment] }; await this.store.save(saved);
  this.live = false; this.state = undefined;
  const final = (await this.read()).state; this.state = final; this.publish(); return final;
 }
}

import { resolve } from 'node:path';
import type { CombinedRecorder } from 'footprintjs';
import type { InfraGraph } from '../graph/types.ts';
import type { FileResourceFlowStore } from '../resource-flow/store.ts';
import type { ResourceFlowProfiles } from '../resource-flow/profile-catalog.ts';
import type { ResourceFlowResumeInput, ResourceFlowStartInput, ResourceFlowState } from '../resource-flow/types.ts';
import { freeze } from '../graph/data.ts';
import { createAgentReadinessFlow } from './create-agent-readiness-flow.ts';
import { readAgentDeployment } from './data.ts';
import { recordedAgentCapabilities } from './verification.ts';
import { admitAgentReadinessRecording } from './recording.ts';
import type { AgentDeployment, AgentEnvironmentAdapters, AgentReadinessState } from './types.ts';

export interface AgentReadinessOptions {
 definition: AgentDeployment; graph: InfraGraph; store: FileResourceFlowStore; profiles: ResourceFlowProfiles;
 profileCatalogId?: string; requireProfileAtStart?: boolean; adapters: AgentEnvironmentAdapters; recorders?: readonly CombinedRecorder[];
}
/** An optional domain wrapper. The base native workflow owns effects, checkpoints and one-use resume. */
export class AgentReadinessWorkflow {
 private readonly definition: AgentDeployment; private readonly flow: ReturnType<typeof createAgentReadinessFlow>; private readonly directory: string;
 private readonly listeners = new Set<(state: AgentReadinessState) => void>();
 private publication = 0;
 private operationInProgress = false;
 private liveExecution = false;
 constructor(options: AgentReadinessOptions) {
  this.definition = readAgentDeployment(options.definition, options.graph); this.directory = resolve(options.store.directory);
  this.flow = createAgentReadinessFlow({ ...options, definition: this.definition });
  this.flow.subscribe(state => { this.liveExecution = this.operationInProgress && state.status === 'running'; void this.publish(state); });
 }
 async snapshot(): Promise<AgentReadinessState> { return this.admit(await this.flow.snapshot()); }
 async start(input?: ResourceFlowStartInput): Promise<AgentReadinessState> {
  return this.execute(() => this.flow.start(input));
 }
 async resume(input: ResourceFlowResumeInput): Promise<AgentReadinessState> {
  return this.execute(() => this.flow.resume(input));
 }
 subscribe(listener: (state: AgentReadinessState) => void): () => void {
  if (typeof listener !== 'function') throw Error('An agent readiness listener must be callable'); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
 }
 private async execute(work: () => Promise<ResourceFlowState>): Promise<AgentReadinessState> {
  if (this.operationInProgress) throw Error('An agent readiness operation is already running');
  this.operationInProgress = true;
  try { return await this.admit(await work()); } finally { this.operationInProgress = false; this.liveExecution = false; }
 }
 private project(flow: ResourceFlowState): AgentReadinessState {
  const capabilities = recordedAgentCapabilities(flow.verification, this.definition.capabilityIds);
  const ready = flow.status === 'passed' && this.definition.requiredCheckIds.every(id => flow.verification?.checks.some(check => check.id === id && check.passed))
   && this.definition.requiredCapabilities.every(id => capabilities.some(capability => capability.id === id && capability.status === 'supported' && capability.proof));
  if (flow.status === 'passed' && !ready) throw Error('Agent native verification no longer satisfies its readiness policy');
  return freeze({ version: 1, kind: 'agent-readiness', definition: this.definition, revision: this.definition.revision,
   status: ready ? 'ready' : flow.status === 'passed' || flow.status === 'running' && !this.liveExecution ? 'incomplete' : flow.status, ready, capabilities, flow });
 }
 private async admit(flow: ResourceFlowState): Promise<AgentReadinessState> {
  await admitAgentReadinessRecording(this.definition, flow, this.directory); return this.project(flow);
 }
 private async publish(flow: ResourceFlowState): Promise<void> {
  const number = ++this.publication;
  let state: AgentReadinessState;
  try { state = flow.status === 'passed' || flow.status === 'paused' || flow.status === 'failed' ? await this.admit(flow) : this.project(flow); }
  catch { state = freeze({ version: 1, kind: 'agent-readiness', definition: this.definition, revision: this.definition.revision,
   status: 'incomplete', ready: false, flow: { ...flow, status: 'incomplete' },
   capabilities: this.definition.capabilityIds.map(id => ({ id, status: 'unknown' as const, source: 'unmeasured' as const })) }); }
  if (number !== this.publication) return;
  for (const listener of this.listeners) { try { listener(state); } catch { /* Observation never changes provider execution. */ } }
 }
}

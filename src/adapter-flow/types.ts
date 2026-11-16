import type { CombinedRecorder, EmitEvent, FlowChart } from 'footprintjs';

export const ADAPTER_FLOW_EVENT = 'iac.adapter.progress';
/** Public, non-secret identity supplied by the controller, never by host output. */
export interface AdapterFlowContext {
  deploymentRunId: string; adapterId: string; resourceId: string; operationId: string;
}
export type AdapterFlowPhase = 'inspect' | 'revalidate' | 'configure' | 'reload' | 'start' | 'apply' | 'observe';
export type AdapterFlowStatus = 'running' | 'passed' | 'failed' | 'unknown';
export interface AdapterFlowProgress extends AdapterFlowContext {
  version: 1; componentId?: string; phase: AdapterFlowPhase; status: AdapterFlowStatus;
  installed?: boolean; running?: boolean;
}
export interface AdapterFlowEvent extends AdapterFlowProgress {
  /** Native FootPrint source-position run identity, distinct from the deployment controller UUID. */
  runId: string; logRunId: string; runtimeStageId: string; subflowPath: readonly string[]; stageName: string;
  committedThroughIdx: number;
  drillPath: readonly string[];
  timestamp: number; sequence: number;
}
export type AdapterFlowOutcome = { status: 'passed' } | { status: 'failed' | 'unknown'; code: string };
/** A pure factory. Building a chart must not inspect, mutate or acquire a provider permit. */
export type AdapterApplyFlowFactory<R, C> = (resource: R, context: C, binding: AdapterFlowContext) => FlowChart<any, any>;
export interface AdapterFlowRecorder extends CombinedRecorder {
  clear(): void;
  getEvents(afterSequence?: number): readonly AdapterFlowEvent[];
  subscribe(listener: (event: AdapterFlowEvent) => void): () => void;
  getSnapshot(): { version: 1; events: readonly AdapterFlowEvent[]; ignoredEvents: number; subscriberFailures: number };
}
export type NativeAdapterEmit = EmitEvent;

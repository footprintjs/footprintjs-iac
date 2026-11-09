import type { CombinedRecorder, FlowChart, RuntimeSnapshot } from 'footprintjs';
import type { InfraGraph, Relation } from '../graph/types.ts';
import type { JsonObject, Resource } from '../types.ts';

export const CONNECTION_EVENT = 'iac.connection.progress';
export type ConnectionStatus = 'checking' | 'connected' | 'failed';
export interface ConnectionCheckRequest {
  connectionId: string;
  stack: string;
  from: Resource;
  to: Resource;
  relation: Relation;
}
/** Measured point-in-time evidence; a failed check may retain partial observations. */
export interface ConnectionObservation {
  method: string;
  target: string;
  observedAt: number;
  latencyMs: number;
  details: JsonObject;
}
export interface ConnectionAdapter { check(request: ConnectionCheckRequest): Promise<ConnectionObservation> }
/** Failed probes may still carry real partial measurements; those never imply connected. */
export class ConnectionCheckError extends Error {
  readonly observation?: ConnectionObservation;
  readonly details?: JsonObject;
  constructor(message: string, observation?: ConnectionObservation, details?: JsonObject) {
    super(message); this.name = 'ConnectionCheckError';
    if (observation !== undefined) this.observation = observation;
    if (details !== undefined) this.details = details;
  }
}
export interface ConnectionCheckResult {
  connectionId: string;
  from: string;
  to: string;
  status: 'connected' | 'failed';
  observation?: ConnectionObservation;
  error?: string;
  details?: JsonObject;
}
export interface ConnectionEvent {
  readonly version: 1;
  readonly sequence: number;
  readonly runId: string;
  readonly connectionId: string;
  readonly from: string;
  readonly to: string;
  readonly status: ConnectionStatus;
  readonly timestamp: number;
  readonly runtimeStageId: string;
  readonly message?: string;
  readonly observation?: ConnectionObservation;
  readonly details?: JsonObject;
}
export interface ConnectionSnapshot {
  readonly version: 1;
  readonly runId: string | null;
  readonly sequence: number;
  readonly connections: Readonly<Record<string, ConnectionEvent>>;
  readonly events: readonly ConnectionEvent[];
  readonly ignoredEvents: number;
  readonly subscriberFailures: number;
}
export interface ConnectionRecorder extends CombinedRecorder {
  getSnapshot(): ConnectionSnapshot;
  getEvents(afterSequence?: number): readonly ConnectionEvent[];
  subscribe(listener: (event: ConnectionEvent) => void): () => void;
}
export interface ConnectionCheckOptions {
  graph: InfraGraph;
  adapter: ConnectionAdapter;
  recorders?: readonly CombinedRecorder[];
  traceDirectory?: string;
}
export interface ConnectionRunResult {
  version: 1;
  stack: string;
  graph: InfraGraph;
  runId: string;
  ok: boolean;
  checks: Record<string, ConnectionCheckResult>;
  events: readonly ConnectionEvent[];
  snapshot: RuntimeSnapshot;
  structure: FlowChart['buildTimeStructure'];
  controlDeps: Record<string, unknown>;
  decisions: unknown;
  narrative: unknown;
  tracePath?: string;
  traceStatus?: { entries: number; failed: number; flushed: boolean; error?: string };
}

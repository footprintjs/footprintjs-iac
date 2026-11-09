import type { CombinedRecorder } from 'footprintjs';
import type { Action } from '../types.ts';

export const DEPLOYMENT_EVENT = 'iac.resource.progress';
export type DeploymentStatus = 'pending' | 'deploying' | 'ready' | 'failed' | 'skipped' | 'deleted';

/** The payload is projected from a native EmitEvent, not inferred from elapsed time. */
export interface DeploymentEvent {
  readonly version: 1;
  readonly sequence: number;
  readonly runId: string;
  readonly resourceId: string;
  readonly status: DeploymentStatus;
  readonly action: Action;
  readonly timestamp: number;
  readonly runtimeStageId: string;
  readonly message?: string;
}

export interface DeploymentSnapshot {
  readonly version: 1;
  readonly runId: string | null;
  readonly sequence: number;
  readonly resources: Readonly<Record<string, DeploymentEvent>>;
  readonly events: readonly DeploymentEvent[];
  /** Events with an invalid payload or another run ID are rejected, never merged. */
  readonly ignoredEvents: number;
  /** Subscriber exceptions are isolated from execution and disclosed here. */
  readonly subscriberFailures: number;
}

export interface DeploymentRecorder extends CombinedRecorder {
  getSnapshot(): DeploymentSnapshot;
  getEvents(afterSequence?: number): readonly DeploymentEvent[];
  subscribe(listener: (event: DeploymentEvent) => void): () => void;
}

import type { CheckRequest, CheckTarget, CheckExecutionState } from '../checks/types.ts';

export type TriggerKind = 'manual' | 'interval' | 'stage-event';
/** Definitions are registered by the host. Browser controls select IDs, never commands or endpoints. */
export interface TriggerDefinition {
  version: 1; id: string; label: string; adapterId: string; kind: TriggerKind; configurationDigest: string;
  runnerId: string; suiteId: string; suiteDigest: string; stageId: string; target: CheckTarget;
  overlap: 'skip'; missed: 'skip' | 'coalesce';
  schedule?: { everyMs: number; startsAt: number };
  source?: { pipelineId: string; definitionDigest: string };
}
export interface TriggerCapability { id: string; label: string; kind: TriggerKind; everyMs?: number }
export interface StageEventReference { pipelineId: string; definitionDigest: string; executionId: string; stageId: string; sequence: number }
export interface StageCompletion {
  reference: StageEventReference; target: CheckTarget;
  releaseId: string; releaseDigest: string; status: 'passed';
}
export interface DeployedRelease { id: string; digest: string }
export interface TriggerSignal { requestId?: string; event?: StageEventReference }
export interface TriggerCandidate {
  dedupeKey: string; scheduledAt: number; reason: CheckRequest['reason']; dispatch: boolean;
  nextDueAt?: number; completion?: StageCompletion;
}
export interface TriggerAdapter {
  readonly id: string; readonly kind: TriggerKind;
  admit(definition: TriggerDefinition): void;
  prepare(input: { definition: TriggerDefinition; nextDueAt?: number; now: number; signal?: TriggerSignal }): Promise<TriggerCandidate | undefined>;
}
export interface TriggerInvocation {
  id: string; dedupeKey: string; scheduledAt: number; dispatchedAt: number;
  status: 'running' | 'passed' | 'failed' | 'incomplete' | 'skipped';
  lease?: { token: string; expiresAt: number };
  request?: CheckRequest; result?: CheckExecutionState;
}
export interface TriggerJobState {
  version: 1; kind: 'trigger-job'; definition: TriggerDefinition; definitionDigest: string;
  nextDueAt?: number; invocations: TriggerInvocation[];
}
/** Hosts can replace local persistence/leases while retaining the finite dispatcher contract. */
export interface TriggerStore {
  load(id: string): Promise<TriggerJobState | undefined>;
  save(state: TriggerJobState): Promise<void>;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  runDirectory(triggerId: string, invocationId: string): string;
}
export interface TriggerDispatch {
  status: 'not-due' | 'duplicate' | 'overlap' | 'skipped' | 'passed' | 'failed' | 'incomplete';
  invocation?: TriggerInvocation;
}

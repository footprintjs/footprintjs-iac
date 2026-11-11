import type { InfraGraph } from '../graph/types.ts';
import type { Plan, Action } from '../types.ts';

/** Non-secret host binding. A release cannot silently move its durable state to another target. */
export interface MasterTarget { readonly id: string; readonly scope: string }
export interface MasterSource { readonly repository?: string; readonly commit?: string; readonly tree?: string }
export interface MasterArtifact { readonly id: string; readonly digest: string; readonly reference?: string }
export interface SystemRevision {
  readonly kind: 'system-revision'; readonly schemaVersion: 1;
  readonly revisionId: string; readonly parentDigest: string | null; readonly digest: string;
  readonly target: MasterTarget; readonly graph: InfraGraph;
  readonly source?: MasterSource; readonly artifacts?: readonly MasterArtifact[];
}
export type ResourceChangeKind = 'added' | 'changed' | 'removed' | 'unchanged';
export interface ResourceChange { readonly resourceId: string; readonly kind: ResourceChangeKind; readonly paths: readonly string[] }
export interface SystemRevisionChanges {
  readonly previousDigest: string | null; readonly candidateDigest: string;
  readonly graphChanged: boolean; readonly metadataChanged: boolean;
  readonly resources: readonly ResourceChange[];
  readonly counts: Readonly<Record<ResourceChangeKind, number>>;
}
export interface MasterReview {
  readonly reviewId: string; readonly candidateDigest: string; readonly parentDigest: string | null;
  readonly planDigest: string; readonly plannedAt: string; readonly prune: boolean;
  readonly plan: Plan; readonly changes: SystemRevisionChanges;
}
export interface MasterAttempt {
  readonly attemptId: string; readonly revisionDigest: string; readonly previousAppliedDigest: string | null;
  readonly status: 'running' | 'applied' | 'failed' | 'incomplete'; readonly kind: 'adopt' | 'apply';
  readonly startedAt: string; readonly finishedAt?: string;
  readonly reviewId?: string; readonly planDigest?: string; readonly runId?: string;
  readonly evidencePath?: string; readonly tracePath?: string; readonly message?: string;
  readonly actions?: readonly { resourceId: string; action: Action }[];
}
export interface MasterState {
  schemaVersion: 1; kind: 'master-system-state';
  target: MasterTarget | null;
  appliedDigest: string | null; candidateDigest: string | null;
  revisions: SystemRevision[]; attempts: MasterAttempt[]; review?: MasterReview;
}
export interface RevisionInput {
  revisionId: string; parentDigest: string | null; target: MasterTarget; graph: InfraGraph;
  source?: MasterSource; artifacts?: readonly MasterArtifact[];
}

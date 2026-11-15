export const CHECK_STATUSES = ['passed', 'failed', 'inconclusive', 'error', 'skipped'] as const;
export type CheckStatus = typeof CHECK_STATUSES[number];
export interface CheckTarget { id: string; scope: string }
export interface CheckSuite { id: string; label: string; digest: string; kind: string }
export interface CheckRequest {
  invocationId: string; suiteId: string; suiteDigest: string; releaseId: string; releaseDigest: string;
  stageId: string; target: CheckTarget;
  reason: 'after-deploy' | 'rollout-analysis' | 'recovery' | 'scheduled' | 'manual';
}
export interface CheckObservation {
  id: string; status: CheckStatus; statusCode?: number; durationMs?: number;
}
export interface CheckArtifact { id: string; digest: string; reference: string }
export interface CheckReceipt { runId?: string; evidencePath?: string; tracePath?: string }
export interface CheckResult {
  request: CheckRequest; status: CheckStatus; checks: CheckObservation[];
  artifacts?: CheckArtifact[]; receipt?: CheckReceipt;
}
/** Tool implementations are trusted host composition; requests contain no commands, paths or URLs. */
export interface CheckRunner {
  readonly id: string;
  suites(): readonly CheckSuite[];
  run(request: CheckRequest): Promise<CheckResult>;
}
export interface CheckExecutionState {
  version: 1; kind: 'check-execution'; runnerId: string; request: CheckRequest; bindingDigest: string;
  status: 'idle' | 'running' | 'passed' | 'failed' | 'incomplete';
  result?: CheckResult;
  recording?: { runId: string; evidencePath: string; tracePath: string; complete: boolean };
}

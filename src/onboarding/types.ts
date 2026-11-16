import type { CombinedRecorder } from 'footprintjs';
import type { DeploymentStrategyAdapter } from '../deployment-strategy/types.ts';

export const ONBOARDING_STAGE_IDS = ['discover', 'configure', 'verify', 'review', 'deploy'] as const;
export type OnboardingStageId = typeof ONBOARDING_STAGE_IDS[number];
export interface OnboardingCheck { id: string; label: string; status: 'passed' | 'failed' | 'unknown' }
export interface OnboardingCheckAdapter {
  readonly id: string;
  /** Change this digest whenever the registered check implementation or its private configuration changes. */
  readonly configurationDigest: string;
  readonly requiredCheckIds: readonly string[];
  run(input: { targetId: string; profileId?: string }): Promise<readonly OnboardingCheck[]>;
}
export interface OnboardingPresetDefinition {
  version: 1; id: string; label: string;
  strategyId: string; targetId: string; configurationDigest: string;
  /** A public selection of an already registered private connection profile. */
  profileId?: string;
}
export interface OnboardingChange {
  resourceId: string; label: string; action: 'create' | 'update' | 'noop' | 'replace' | 'delete' | 'blocked';
}
export interface OnboardingReview { ok: boolean; reviewId?: string; changes: readonly OnboardingChange[] }
export interface OnboardingDeployment { ok: boolean; promoted: boolean; status: 'promoted' | 'blocked' | 'apply-failed' | 'verification-failed' | 'incomplete'; checks?: readonly OnboardingCheck[] }
export interface OnboardingRecording { runId: string }
export interface OnboardingSnapshot {
  id: string; label: string; strategyId: string; targetId: string; configurationDigest: string; profileId?: string;
  status: 'idle' | 'discovered' | 'configured' | 'verified' | 'reviewed' | 'ready' | 'failed' | 'incomplete'; busy: boolean;
  stages: readonly { id: OnboardingStageId; label: string; status: 'pending' | 'running' | 'passed' | 'failed' | 'unknown' }[];
  checks: readonly OnboardingCheck[];
  canDiscover: boolean; canConfigure: boolean; canVerify: boolean; canReview: boolean; canDeploy: boolean; canReconcile: boolean;
  review?: OnboardingReview; deployment?: OnboardingDeployment; recording?: OnboardingRecording; error?: string;
}
export type OnboardingAction =
  | { action: 'discover' | 'configure' | 'verify' | 'review' | 'refresh' }
  | { action: 'deploy' | 'reconcile'; reviewId: string };
export interface OnboardingPreset {
  readonly definition: OnboardingPresetDefinition;
  readonly deployment: DeploymentStrategyAdapter;
  readonly adapters: Readonly<Record<'discover' | 'configure' | 'verify', OnboardingCheckAdapter>>;
  /** Pure safe projection of the registered strategy's plan; never raw provider output. */
  readonly projectReview?: (review: unknown) => readonly OnboardingChange[];
  /** Pure projection of measured application checks; never raw reports, tokens or provider configuration. */
  readonly projectDeployment?: (deployment: unknown) => readonly OnboardingCheck[];
}
export interface OnboardingWorkflowOptions {
  preset: OnboardingPreset; directory: string; recorders?: readonly CombinedRecorder[];
}

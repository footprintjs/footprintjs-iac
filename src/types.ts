import type { AdapterApplyFlowFactory } from './adapter-flow/types.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ResourceLifecycle {
  /** Omission preserves saved intent; clear explicitly with false before pruning. */
  retainOnRemoval?: boolean;
}

export interface Resource {
  id: string;
  provider: string;
  dependsOn?: string[];
  lifecycle?: ResourceLifecycle;
  spec: JsonObject;
}

export interface Stack {
  name: string;
  resources: Resource[];
}

export interface Observation {
  exists: boolean;
  fingerprint?: string;
  physicalId?: string;
  /** An existing resource may be changed only if this adapter verifies our ownership. */
  owned?: boolean;
  ready?: boolean;
  /** Optional non-secret output values published by the provider once verified. */
  attributes?: JsonObject;
}

export interface ProviderContext {
  stack: string;
  /** Stable across retries of the same desired operation. */
  operationId: string;
  /** Last known provider identifier for this logical resource. Ownership still has to be verified. */
  physicalId?: string;
}

export interface ResourceApplyReceipt { physicalId: string }

export type ResourceChangeAssessment =
  | { disposition: 'update'; reason?: string }
  | { disposition: 'replace' | 'reject'; reason: string };

/** Adapters expose provider semantics; a successful send is not a readiness guarantee. */
export interface ResourceAdapter {
  readonly name: string;
  /** Identifies the actual API target; saved state cannot silently switch targets. */
  readonly scope?: string;
  readonly supportsSafeRetry?: boolean;
  observe(resource: Resource, context: ProviderContext): Promise<Observation>;
  apply(resource: Resource, context: ProviderContext): Promise<void | ResourceApplyReceipt>;
  /** Pure provider-specific classification of an already managed resource's desired change. */
  assessChange?(previous: Resource, desired: Resource): ResourceChangeAssessment;
  /** Optional native child chart. Legacy callbacks remain opaque; this factory performs no I/O. */
  createApplyFlow?: AdapterApplyFlowFactory<Resource, ProviderContext>;
  /** Observation-only child chart, including no-op deployments. It must not apply or acquire an effect permit. */
  createVerifyFlow?: AdapterApplyFlowFactory<Resource, ProviderContext>;
  remove(resource: Resource, context: ProviderContext): Promise<void>;
  waitReady(resource: Resource, context: ProviderContext): Promise<void>;
  /** Explicit observation-only settlement of an earlier uncertain effect. Never applies or repairs. */
  inspectOutcome?(resource: Resource, context: ProviderContext): Promise<ResourceOutcomeInspection>;
}

export interface ResourceOutcomeInspection {
  runtimeControlReturned: boolean;
  quiescent: boolean;
  observation: Observation;
  evidence: JsonObject;
}

export type Action = 'create' | 'update' | 'verify' | 'delete' | 'noop';
export interface PlannedOperation {
  resource: Resource;
  action: Action;
  desiredFingerprint: string;
  observed: Observation;
  operationId: string;
  /** Resolved review input or a value to be obtained after a planned dependency change. */
  inputResolution?: { spec: JsonObject } | { deferred: true };
}

export interface Plan {
  stack: string;
  operations: PlannedOperation[];
  /** Omitted managed resources and saved dependencies protected from this prune. */
  retained?: { resourceId: string; reason: 'retention-policy' | 'dependency' }[];
}

export interface ManagedResource {
  resource: Resource;
  fingerprint: string;
  physicalId?: string;
  attributes?: JsonObject;
  pending?: { operationId: string; action: 'create' | 'update'; desiredFingerprint: string; resolvedSpec?: JsonObject };
}

export interface StackState {
  version: 1;
  stack: string;
  resources: Record<string, ManagedResource>;
  providerScopes?: Record<string, string>;
  reconciliations?: { originalRunId: string; runId: string; evidencePath: string; tracePath: string; digest: string }[];
}

export interface JournalEntry {
  event: 'begin' | 'observed' | 'complete' | 'failed';
  stack?: string;
  runId: string;
  operationId: string;
  resourceId: string;
  action: Action;
  at: string;
  detail?: string;
}

/** Durably records intent before effects; evidence snapshots have a separate lifecycle. */
export interface StateStore {
  load(stack: string): Promise<StackState>;
  save(state: StackState): Promise<void>;
  append(entry: JournalEntry): Promise<void>;
  withLock<T>(stack: string, work: () => Promise<T>): Promise<T>;
  saveEvidence(runId: string, evidence: unknown): Promise<string>;
}

export interface FailureDecision {
  retry: boolean;
  reason: string;
}

export interface FailureStrategy {
  readonly maxAttempts: number;
  decide(error: unknown, observation: Observation | undefined, attempt: number): FailureDecision;
}

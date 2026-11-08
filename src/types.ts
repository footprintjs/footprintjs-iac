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
}

export interface ProviderContext {
  stack: string;
  /** Stable across retries of the same desired operation. */
  operationId: string;
}

/** Adapters expose provider semantics; a successful send is not a readiness guarantee. */
export interface ResourceAdapter {
  readonly name: string;
  /** Identifies the actual API target; saved state cannot silently switch targets. */
  readonly scope?: string;
  readonly supportsSafeRetry?: boolean;
  observe(resource: Resource, context: ProviderContext): Promise<Observation>;
  apply(resource: Resource, context: ProviderContext): Promise<void>;
  remove(resource: Resource, context: ProviderContext): Promise<void>;
  waitReady(resource: Resource, context: ProviderContext): Promise<void>;
}

export type Action = 'create' | 'update' | 'verify' | 'delete' | 'noop';
export interface PlannedOperation {
  resource: Resource;
  action: Action;
  desiredFingerprint: string;
  observed: Observation;
  operationId: string;
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
  pending?: { operationId: string; action: 'create' | 'update'; desiredFingerprint: string };
}

export interface StackState {
  version: 1;
  stack: string;
  resources: Record<string, ManagedResource>;
  providerScopes?: Record<string, string>;
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

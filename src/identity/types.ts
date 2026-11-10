import type { CombinedRecorder, FlowChart, RuntimeSnapshot } from 'footprintjs';

/** Only an authentication adapter may establish this subject; declaration alone is not verification. */
export interface IdentitySubject { readonly id: string; readonly source: string; readonly groups: readonly string[] }
/** Architectural reference. Managed ownership requires its own supported deployment adapter. */
export interface IdentitySource { readonly id: string; readonly kind: 'directory'; readonly ownership: 'external' | 'managed' }
/** Trusted synchronous compiler extension; binding alone does not contact or provision a provider. */
export interface IdentityBindingAdapter<TOptions, TBinding> {
  readonly id: string;
  bind(source: IdentitySource, options: TOptions): TBinding;
}
export interface IdentityCredentials { readonly username: string; readonly password: string }
export type IdentityAuthentication =
  | { readonly status: 'authenticated'; readonly subject: IdentitySubject }
  | { readonly status: 'rejected'; readonly code: 'invalid-credentials' }
  | { readonly status: 'unavailable'; readonly code: IdentityObservationCode };
/** Credentials are transient adapter inputs, never native chart requests or recorded state. */
export interface IdentitySourceAdapter<TCredential = IdentityCredentials> {
  readonly id: string;
  authenticate(credential: TCredential): Promise<IdentityAuthentication>;
}
export interface AccessRule {
  readonly id: string; readonly effect: 'allow' | 'deny'; readonly source: string;
  /** Either an exact subject or any exact group matches the actor; these lists are alternatives (OR). */
  readonly subjects?: readonly string[]; readonly groups?: readonly string[];
  readonly actions: readonly string[]; readonly resources: readonly string[];
}
export interface AccessPolicy { readonly id: string; readonly rules: readonly AccessRule[] }
export interface AccessRequest { readonly action: string; readonly resource: string }
export interface AccessDecision {
  readonly effect: 'allowed' | 'denied'; readonly policyId: string; readonly matchedRuleIds: readonly string[];
  readonly reason: 'matching-allow' | 'explicit-deny' | 'default-deny';
}

export type IdentityCheckKind = 'login' | 'access' | 'directory';
export type IdentityExpectedVerdict = 'authenticated' | 'rejected' | 'allowed' | 'denied' | 'available';
export type IdentityVerdict = IdentityExpectedVerdict | 'unavailable';
export type IdentityObservationCode = 'verified' | 'invalid-credentials' | 'anonymous' | 'access-allowed' | 'access-denied'
  | 'directory-unavailable' | 'identity-unavailable' | 'transport-failure' | 'tls-error' | 'connection-refused'
  | 'provider-unavailable' | 'backend-error' | 'invalid-observation' | 'adapter-failure';
/** An allowlist of diagnostic metadata. Raw bodies, headers, tokens and credentials are not accepted. */
export interface IdentityObservationDetails {
  readonly code?: IdentityObservationCode; readonly httpStatus?: number; readonly sourceId?: string;
  readonly subjectId?: string; readonly policyId?: string; readonly matchedRuleIds?: readonly string[];
  readonly action?: string; readonly resource?: string;
  readonly protocol?: 'ldap' | 'ldaps' | 'oidc' | 'http' | 'https';
  readonly phase?: 'directory' | 'authentication' | 'authorization' | 'transport';
}
export interface IdentityCheckRequest {
  readonly id: string; readonly label: string; readonly kind: IdentityCheckKind; readonly expected: IdentityExpectedVerdict;
}
export interface AccessObservation {
  readonly verdict: IdentityVerdict; readonly observedAt: number; readonly latencyMs: number;
  readonly details?: IdentityObservationDetails;
}
/** Trusted extension: keep secrets in its closure and return only measured, allowlisted metadata. */
export interface AccessCheckAdapter { readonly id?: string; check(request: IdentityCheckRequest): Promise<AccessObservation> }
export interface IdentityCheckResult {
  readonly checkId: string; readonly label: string; readonly kind: IdentityCheckKind;
  readonly expected: IdentityExpectedVerdict; readonly status: 'passed' | 'failed';
  readonly observation: AccessObservation; readonly message?: string;
}
export const IDENTITY_EVENT = 'iac.identity.progress';
export interface IdentityEvent {
  readonly version: 1; readonly sequence: number; readonly runId: string;
  readonly checkId: string; readonly label: string; readonly kind: IdentityCheckKind; readonly expected: IdentityExpectedVerdict;
  readonly status: 'checking' | 'passed' | 'failed'; readonly timestamp: number; readonly runtimeStageId: string;
  readonly observation?: AccessObservation; readonly message?: string;
}
export interface IdentitySnapshot {
  readonly version: 1; readonly runId: string | null; readonly sequence: number;
  readonly checks: Readonly<Record<string, IdentityEvent>>; readonly events: readonly IdentityEvent[];
  readonly ignoredEvents: number; readonly subscriberFailures: number;
}
export interface IdentityRecorder extends CombinedRecorder {
  getSnapshot(): IdentitySnapshot;
  getEvents(afterSequence?: number): readonly IdentityEvent[];
  subscribe(listener: (event: IdentityEvent) => void): () => void;
}
export interface IdentityCheckOptions {
  readonly stack: string; readonly checks: readonly IdentityCheckRequest[]; readonly adapter: AccessCheckAdapter;
  readonly recorders?: readonly CombinedRecorder[]; readonly traceDirectory?: string;
}
export interface IdentityRunResult {
  readonly version: 1; readonly stack: string; readonly runId: string; readonly ok: boolean;
  readonly checks: Readonly<Record<string, IdentityCheckResult>>; readonly events: readonly IdentityEvent[];
  readonly snapshot: RuntimeSnapshot; readonly structure: FlowChart['buildTimeStructure'];
  readonly controlDeps: Record<string, unknown>; readonly decisions: unknown; readonly narrative: unknown;
  readonly tracePath?: string;
  readonly traceStatus?: { entries: number; failed: number; flushed: boolean; error?: string };
}
export interface AuthorizeAccessOptions extends AccessRequest {
  readonly policy: AccessPolicy; readonly subject: IdentitySubject; readonly stack?: string;
  readonly recorders?: readonly CombinedRecorder[]; readonly traceDirectory?: string;
}
export interface AuthorizationRunResult {
  readonly version: 1; readonly stack: string; readonly runId: string; readonly decision: AccessDecision;
  readonly snapshot: RuntimeSnapshot; readonly structure: FlowChart['buildTimeStructure'];
  readonly controlDeps: Record<string, unknown>; readonly decisions: unknown; readonly narrative: unknown;
  readonly tracePath?: string;
  readonly traceStatus?: { entries: number; failed: number; flushed: boolean; error?: string };
}

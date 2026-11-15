/** References to admitted management access; these never contain credentials. */
export interface HostRef { id: string; scope: string; profileId: string }
export interface HostOperationContext { executionId: string; operationId: string; expectedIdentityDigest?: string }
export interface HostAction {
  id: string;
  /** Trusted host registration only. Do not deserialize scripts from a graph or plan. */
  script: string;
  effect: 'read-only' | 'mutating';
}
export interface HostActionDescriptor { id: string; digest: string; effect: 'read-only' | 'mutating' }
export interface HostActionResult { stdout: string }
/** Host-owned adapter. Operation adapters must project output before placing it in a recorder. */
export interface HostAccessTransport {
  readonly id: string;
  readonly host: HostRef;
  actions(): readonly HostActionDescriptor[];
  run(actionId: string, context: HostOperationContext): Promise<HostActionResult>;
}
export interface HostToolObservation { status: 'installed' | 'absent' | 'unknown'; version?: string }
export interface HostFactsSnapshot {
  version: 1;
  kind: 'host-facts';
  host: HostRef;
  observedAt: number;
  status: 'complete' | 'partial' | 'unavailable';
  /** SHA-256 of a machine-stable identifier. Null means identity has not been established. */
  identityDigest: string | null;
  os: { family: 'linux' | 'darwin' | 'windows' | 'unknown'; distribution: string | null; version: string | null; kernel: string | null };
  architecture: 'amd64' | 'arm64' | 'unknown';
  cpuCount: number | null;
  memory: { totalBytes: number | null; availableBytes: number | null };
  disk: { path: string; totalBytes: number | null; availableBytes: number | null };
  privilege: 'root' | 'sudo-noninteractive' | 'unprivileged' | 'unknown';
  /** Adapter-observed software by safe ID. A missing entry is unobserved, never proof of absence. */
  tools: Record<string, HostToolObservation>;
  kubernetes: { status: 'present' | 'absent' | 'unknown' };
  digest: string;
}
export interface HostDiscoveryPort {
  readonly id: string;
  inspect(host: HostRef, context: HostOperationContext): Promise<HostFactsSnapshot>;
}
export interface HostProcessRequest { file: string; args: readonly string[]; input: string; timeoutMs: number; maxOutputBytes: number }
export type HostProcessRunner = (request: HostProcessRequest) => Promise<{ stdout: string; stderr?: string; code: number }>;

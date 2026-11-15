import type { BootstrapContext, PublishedClusterAccess } from '../platform-bootstrap/types.ts';
import type { KubernetesTargetRegistration } from '../kubernetes-workload/types.ts';
import type { ResourceHandle } from '../resource-flow/types.ts';

export interface KubernetesReadResponse { status: number; body: unknown }
/** A trusted host-only read port. Consumers cannot supply a method, URL or request body. */
export type KubernetesReadonlyRunner = (path: string) => Promise<KubernetesReadResponse>;
export interface PinnedKubernetesConnectionOptions {
  resourceId: string; scope: string; registration: KubernetesTargetRegistration;
  expectedVersion: string; expectedNodeNames: readonly string[];
  /** Immutable profile bound to these credentials. Otherwise the first successful publication binds it. */
  expectedProfileId?: string;
  cni: { namespace: string; kind: 'DaemonSet' | 'Deployment'; name: string };
  systemNamespace?: string;
  ca: string | Buffer; cert?: string | Buffer; key?: string | Buffer;
  token?: (signal?: AbortSignal) => Promise<string | undefined>; timeoutMs?: number;
  /** Host-owned publication must bind the new immutable profile to this pinned target/TLS identity. */
  publishAccess?: (resource: ResourceHandle, context: BootstrapContext) => Promise<PublishedClusterAccess | undefined>;
  /** Controlled tests or another trusted host transport only; it must uphold the same pinned TLS target. */
  runner?: KubernetesReadonlyRunner;
}

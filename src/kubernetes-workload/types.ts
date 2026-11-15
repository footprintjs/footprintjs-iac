import type { InfraGraph } from '../graph/types.ts';
import type { Resource, ResourceAdapter } from '../types.ts';

export interface KubernetesKeyReference { name: string; key: string }
export type KubernetesEnvironmentReference =
  | { secretKeyRef: KubernetesKeyReference; configMapKeyRef?: never }
  | { configMapKeyRef: KubernetesKeyReference; secretKeyRef?: never };
export interface KubernetesContainerPort { name?: string; containerPort: number; protocol?: 'TCP' | 'UDP' }
export interface KubernetesProbeTiming {
  initialDelaySeconds?: number; periodSeconds?: number; timeoutSeconds?: number; failureThreshold?: number;
}
export type KubernetesWorkloadProbe = KubernetesProbeTiming & (
  | { httpGet: { path: string; port: number | string }; tcpSocket?: never }
  | { tcpSocket: { port: number | string }; httpGet?: never }
);
export interface KubernetesVolumeItem { key: string; path: string }
export type KubernetesWorkloadVolume = { name: string } & (
  | { secret: { secretName: string; items?: KubernetesVolumeItem[] }; configMap?: never; emptyDir?: never }
  | { configMap: { name: string; items?: KubernetesVolumeItem[] }; secret?: never; emptyDir?: never }
  | { emptyDir: { medium?: 'Memory'; sizeLimit?: string }; secret?: never; configMap?: never }
  | { persistentVolumeClaim: { claimName: string; readOnly?: boolean }; secret?: never; configMap?: never; emptyDir?: never }
);
export interface KubernetesVolumeMount { name: string; mountPath: string; readOnly?: boolean; subPath?: string }
export interface KubernetesContainerResources {
  requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string };
}
export interface KubernetesWorkloadContainer {
  name: string;
  /** An immutable registry/repository@sha256:... reference; no local image loader is used. */
  image: string;
  ports?: KubernetesContainerPort[];
  /** Values remain in externally managed Secret/ConfigMap objects, outside graph/state/recordings. */
  env?: Record<string, KubernetesEnvironmentReference>;
  volumeMounts?: KubernetesVolumeMount[];
  readinessProbe?: KubernetesWorkloadProbe;
  livenessProbe?: KubernetesWorkloadProbe;
  startupProbe?: KubernetesWorkloadProbe;
  resources?: KubernetesContainerResources;
  securityContext?: { runAsUser?: number; runAsGroup?: number; readOnlyRootFilesystem?: boolean };
}
export interface KubernetesWorkloadServicePort {
  name?: string; port: number; targetPort: number | string; protocol?: 'TCP' | 'UDP';
}
export interface KubernetesWorkloadInput {
  stack: string; namespace: string; name: string; replicas?: number;
  deploymentStrategy?: { type: 'Recreate' } | { type: 'RollingUpdate'; rollingUpdate?: { maxSurge: number | string; maxUnavailable: number | string } };
  containers: KubernetesWorkloadContainer[];
  service?: { name?: string; ports: KubernetesWorkloadServicePort[] };
  imagePullSecrets?: string[];
  volumes?: KubernetesWorkloadVolume[];
  podSecurityContext?: { fsGroup?: number; fsGroupChangePolicy?: 'OnRootMismatch' | 'Always' };
}
export interface KubernetesExternalReference {
  kind: 'Secret' | 'ConfigMap' | 'PersistentVolumeClaim'; namespace: string; name: string;
  /** Required key names only; never values. Empty means object presence is required. */
  keys: string[];
}
export interface CompiledKubernetesWorkload {
  graph: InfraGraph; references: KubernetesExternalReference[];
}
export interface KubernetesTargetRegistration {
  apiServer: string;
  /** SHA-256 of the exact trusted CA bundle bytes, lower-case hex, optionally prefixed sha256:. */
  caSha256: string;
  namespace: string;
  /** The existing namespace UID, established by the host during explicit target registration. */
  namespaceUid: string;
}
export interface KubernetesReferenceObservation {
  kind: 'Secret' | 'ConfigMap' | 'PersistentVolumeClaim'; namespace: string; name: string;
  status: 'present' | 'missing' | 'forbidden' | 'unknown';
  uid?: string; keys?: string[];
  /** Required to be true for an existing PVC, whose status must be Bound. */
  ready?: boolean;
}
/** Trusted host ports must use the same admitted target as the delegated ResourceAdapter.
 * Implementations return public identity and key names only, never kube credentials or Secret values.
 */
export interface KubernetesWorkloadTransport {
  getClusterIdentity(namespace: string): Promise<KubernetesTargetRegistration>;
  getReferences(references: readonly KubernetesExternalReference[]): Promise<readonly KubernetesReferenceObservation[]>;
}
export interface KubernetesTargetVerification {
  targetDigest: string; namespaceUidDigest: string; verifiedAt: number;
}
export interface KubernetesReferenceVerification {
  referenceDigest: string; checks: { referenceDigest: string; uidDigest: string; keysDigest: string }[];
  verifiedAt: number;
}
export interface KubernetesTargetGuardPort {
  readonly namespace: string; readonly scope: string;
  verify(): Promise<KubernetesTargetVerification>;
}
export interface KubernetesExternalReferenceProbePort {
  readonly namespace: string;
  verify(references: readonly KubernetesExternalReference[]): Promise<KubernetesReferenceVerification>;
}
export interface KubernetesWorkloadPreflight {
  graphDigest: string; target: KubernetesTargetVerification; references: KubernetesReferenceVerification;
}
export interface GuardedKubernetesAdapterOptions {
  delegate: ResourceAdapter; graph: InfraGraph; guard: KubernetesTargetGuardPort;
  probe: KubernetesExternalReferenceProbePort;
  /** Extra required references supplement, and cannot replace, those extracted from the graph. */
  references?: readonly KubernetesExternalReference[];
  /** Separately reviewed previous resource versions permitted for explicit pruning. */
  allowedRemovals?: readonly Resource[];
}

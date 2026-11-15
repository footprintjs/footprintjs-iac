import { fingerprint } from '../util.ts';
import { KubernetesWorkloadPreflightError } from './errors.ts';
import type { KubernetesTargetGuardPort, KubernetesTargetRegistration, KubernetesTargetVerification, KubernetesWorkloadTransport } from './types.ts';
import { name, object } from './validation.ts';

export function normalizeKubernetesTarget(value: KubernetesTargetRegistration): KubernetesTargetRegistration {
  const input = object(value, ['apiServer', 'caSha256', 'namespace', 'namespaceUid'], 'Kubernetes target registration');
  if (typeof input.apiServer !== 'string') throw new Error('Invalid Kubernetes API endpoint.');
  const endpoint = new URL(input.apiServer);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Kubernetes API endpoint must be an HTTPS origin without credentials.');
  if (typeof input.caSha256 !== 'string' || !/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(input.caSha256)) throw new Error('Kubernetes target requires a pinned CA SHA-256.');
  if (typeof input.namespaceUid !== 'string' || !input.namespaceUid || input.namespaceUid.length > 256 || /[\x00-\x1f\x7f]/.test(input.namespaceUid)) throw new Error('Kubernetes target requires the existing namespace UID.');
  return { apiServer: endpoint.origin, caSha256: input.caSha256.toLowerCase().replace(/^sha256:/, ''),
    namespace: name(input.namespace, 'registered namespace'), namespaceUid: input.namespaceUid };
}

/** Registration is explicit host configuration, never silently learned during deployment. */
export class KubernetesTargetGuard implements KubernetesTargetGuardPort {
  readonly namespace: string;
  readonly scope: string;
  private readonly registration: Readonly<KubernetesTargetRegistration>;
  private readonly transport: KubernetesWorkloadTransport;
  constructor(options: { registration: KubernetesTargetRegistration; transport: KubernetesWorkloadTransport }) {
    this.registration = Object.freeze(normalizeKubernetesTarget(options.registration));
    this.namespace = this.registration.namespace;
    this.scope = `kubernetes-pinned:${fingerprint(this.registration)}`;
    this.transport = options.transport;
  }
  async verify(): Promise<KubernetesTargetVerification> {
    let observed: KubernetesTargetRegistration;
    try { observed = normalizeKubernetesTarget(await this.transport.getClusterIdentity(this.namespace)); }
    catch { throw new KubernetesWorkloadPreflightError('target-identity-unavailable'); }
    if (observed.apiServer !== this.registration.apiServer) throw new KubernetesWorkloadPreflightError('target-endpoint-changed');
    if (observed.caSha256 !== this.registration.caSha256) throw new KubernetesWorkloadPreflightError('target-trust-changed');
    if (observed.namespace !== this.namespace || observed.namespaceUid !== this.registration.namespaceUid) throw new KubernetesWorkloadPreflightError('target-namespace-changed');
    return { targetDigest: fingerprint(this.registration), namespaceUidDigest: fingerprint(observed.namespaceUid), verifiedAt: Date.now() };
  }
}

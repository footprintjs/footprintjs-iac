import { fingerprint } from '../util.ts';
import { KubernetesWorkloadPreflightError } from './errors.ts';
import type { KubernetesExternalReference, KubernetesExternalReferenceProbePort, KubernetesReferenceVerification, KubernetesWorkloadTransport } from './types.ts';
import { key, list, name, object } from './validation.ts';

export function mergeKubernetesReferences(values: readonly KubernetesExternalReference[], namespace: string): KubernetesExternalReference[] {
  name(namespace);
  const merged = new Map<string, KubernetesExternalReference>();
  for (const value of values) {
    const input = object(value, ['kind', 'namespace', 'name', 'keys'], 'external reference');
    if (!['Secret', 'ConfigMap', 'PersistentVolumeClaim'].includes(String(input.kind)) || input.namespace !== namespace) throw new Error('External reference escapes its supported kind or registered namespace.');
    const keys = list(input.keys, 'reference keys', true).map(key).sort();
    if (input.kind === 'PersistentVolumeClaim' && keys.length) throw new Error('PVC references do not contain configuration keys.');
    const ref: KubernetesExternalReference = { kind: input.kind as KubernetesExternalReference['kind'], namespace, name: name(input.name), keys };
    const id = fingerprint({ kind: ref.kind, namespace, name: ref.name });
    const previous = merged.get(id);
    merged.set(id, { ...ref, keys: [...new Set([...(previous?.keys ?? []), ...keys])].sort() });
  }
  return [...merged.values()].sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
}

/** Read-only, point-in-time checks of existing objects; this never adopts or mutates them. */
export class KubernetesExternalReferenceProbe implements KubernetesExternalReferenceProbePort {
  readonly namespace: string;
  private readonly transport: KubernetesWorkloadTransport;
  constructor(options: { namespace: string; transport: KubernetesWorkloadTransport }) {
    this.namespace = name(options.namespace, 'existing namespace');
    this.transport = options.transport;
  }
  async verify(values: readonly KubernetesExternalReference[]): Promise<KubernetesReferenceVerification> {
    const references = mergeKubernetesReferences(values, this.namespace);
    let observations;
    try { observations = await this.transport.getReferences(structuredClone(references)); }
    catch { throw new KubernetesWorkloadPreflightError('reference-observation-unavailable'); }
    if (!Array.isArray(observations) || observations.length !== references.length) throw new KubernetesWorkloadPreflightError('reference-observation-incomplete');
    const checks: KubernetesReferenceVerification['checks'] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const matches = observations.filter(item => item && item.kind === reference.kind && item.namespace === reference.namespace && item.name === reference.name);
      if (matches.length !== 1) throw new KubernetesWorkloadPreflightError('reference-identity-unverified');
      const observation = matches[0]!;
      // A port returning additional fields could accidentally place Secret values in evidence.
      if (Object.keys(observation).some(field => !['kind', 'namespace', 'name', 'status', 'uid', 'keys', 'ready'].includes(field))) throw new KubernetesWorkloadPreflightError('reference-projection-invalid');
      if (observation.status !== 'present') throw new KubernetesWorkloadPreflightError(
        observation.status === 'missing' ? 'reference-missing' : observation.status === 'forbidden' ? 'reference-forbidden' : 'reference-status-unknown');
      if (typeof observation.uid !== 'string' || !observation.uid || observation.uid.length > 256 || /[\x00-\x1f\x7f]/.test(observation.uid)) throw new KubernetesWorkloadPreflightError('reference-uid-unverified');
      if (!Array.isArray(observation.keys) || observation.keys.some((value: unknown) => typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,253}$/.test(value))) throw new KubernetesWorkloadPreflightError('reference-keys-unverified');
      if (reference.keys.some(required => !observation.keys!.includes(required))) throw new KubernetesWorkloadPreflightError('reference-key-missing');
      if (reference.kind === 'PersistentVolumeClaim' && observation.ready !== true) throw new KubernetesWorkloadPreflightError('reference-not-ready');
      const referenceDigest = fingerprint(reference);
      if (seen.has(referenceDigest)) throw new KubernetesWorkloadPreflightError('reference-identity-unverified');
      seen.add(referenceDigest);
      checks.push({ referenceDigest, uidDigest: fingerprint(observation.uid), keysDigest: fingerprint([...observation.keys].sort()) });
    }
    return { referenceDigest: fingerprint(references), checks, verifiedAt: Date.now() };
  }
}

import { createHash, X509Certificate } from 'node:crypto';
import { runKubectl, type CommandRunner } from '../providers/kubernetes.ts';
import { canonical } from '../util.ts';
import type { KubernetesExternalReference, KubernetesReferenceObservation, KubernetesTargetRegistration, KubernetesWorkloadTransport } from './types.ts';
import { normalizeKubernetesTarget } from './target.ts';
import { mergeKubernetesReferences } from './references.ts';
import { name, object } from './validation.ts';

export interface KubectlKubernetesWorkloadTransportOptions {
  context: string; kubeconfig: string; kubectl?: string; runner?: CommandRunner; timeoutMs?: number;
}

// These projections intentionally exclude Secret.data values and kube user/auth fields.
const configProjection = '{{range .clusters}}{{.cluster.server}}{{"\\n"}}{{index .cluster "certificate-authority-data"}}{{"\\n"}}{{index .cluster "insecure-skip-tls-verify"}}{{"\\n"}}{{end}}';
const namespaceProjection = '{{if .metadata.uid}}{"name":{{printf "%q" .metadata.name}},"uid":{{printf "%q" .metadata.uid}}}{{end}}';
function referenceProjection(pvc: boolean): string {
  return '{{if .metadata.uid}}{"kind":{{printf "%q" .kind}},"namespace":{{printf "%q" .metadata.namespace}},"name":{{printf "%q" .metadata.name}},"uid":{{printf "%q" .metadata.uid}},"keys":['
    + (pvc ? '' : '{{range $key,$value := .data}}{{printf "%q," $key}}{{end}}{{range $key,$value := .binaryData}}{{printf "%q," $key}}{{end}}')
    + 'null],"phase":' + (pvc ? '{{printf "%q" .status.phase}}' : '""') + '}{{end}}';
}

/** Read-only kubectl transport. Secret values are excluded by kubectl's projection, before stdout.
 * A dedicated, immutable kubeconfig/context shared with the executor is a host responsibility.
 */
export class KubectlKubernetesWorkloadTransport implements KubernetesWorkloadTransport {
  private readonly options: Readonly<KubectlKubernetesWorkloadTransportOptions>;
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;
  constructor(options: KubectlKubernetesWorkloadTransportOptions) {
    for (const value of [options.context, options.kubeconfig, options.kubectl ?? 'kubectl']) {
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Read-only Kubernetes transport requires explicit safe selectors.');
    }
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120000)) throw new Error('Read-only Kubernetes timeout must be bounded.');
    this.options = Object.freeze({ context: options.context, kubeconfig: options.kubeconfig, kubectl: options.kubectl ?? 'kubectl' });
    this.runner = options.runner ?? runKubectl;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }
  private async command(args: string[]): Promise<string> {
    const result = await this.runner(this.options.kubectl!, ['--context', this.options.context, '--kubeconfig', this.options.kubeconfig,
      '--request-timeout', `${Math.ceil(this.timeoutMs / 1000)}s`, ...args], { timeoutMs: this.timeoutMs + 1000 });
    return result.stdout;
  }
  private async selectedTrust(): Promise<{ apiServer: string; caSha256: string }> {
    const projected = await this.command(['config', 'view', '--minify=true', '--flatten=true', '--raw=true', '-o', `go-template=${configProjection}`]);
    const lines = projected.trimEnd().split('\n');
    if (lines.length !== 3 || !lines[0] || !lines[1] || !['false', '<no value>'].includes(lines[2]!)) throw new Error('Kubernetes target trust projection unavailable.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(lines[1])) throw new Error('Kubernetes target CA projection unavailable.');
    const ca = Buffer.from(lines[1], 'base64');
    if (ca.toString('base64') !== lines[1]) throw new Error('Kubernetes target CA projection invalid.');
    const certificates = ca.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length) throw new Error('Kubernetes target requires explicit trusted CA certificates.');
    for (const certificate of certificates) new X509Certificate(certificate);
    const normalized = normalizeKubernetesTarget({ apiServer: lines[0], caSha256: createHash('sha256').update(ca).digest('hex'), namespace: 'identity-check', namespaceUid: 'identity-check' });
    return { apiServer: normalized.apiServer, caSha256: normalized.caSha256 };
  }
  async getClusterIdentity(namespace: string): Promise<KubernetesTargetRegistration> {
    name(namespace, 'registered namespace');
    try {
      const before = await this.selectedTrust();
      const output = await this.command(['get', 'Namespace', namespace, '--ignore-not-found=true', '-o', `go-template=${namespaceProjection}`]);
      const observed = object(JSON.parse(output), ['name', 'uid'], 'namespace identity projection');
      const after = await this.selectedTrust();
      if (observed.name !== namespace || canonical(before) !== canonical(after)) throw new Error('Kubernetes target changed during identity observation.');
      return normalizeKubernetesTarget({ ...before, namespace, namespaceUid: observed.uid as string });
    } catch {
      // Do not carry command stderr, stdout, credential errors or provider bodies across this port.
      throw new Error('Kubernetes target identity could not be verified.');
    }
  }
  async getReferences(values: readonly KubernetesExternalReference[]): Promise<KubernetesReferenceObservation[]> {
    if (!values.length) return [];
    const namespace = name(values[0]?.namespace);
    const references = mergeKubernetesReferences(values, namespace);
    const results: KubernetesReferenceObservation[] = [];
    for (const reference of references) {
      const identity = { kind: reference.kind, namespace, name: reference.name };
      try {
        const output = await this.command(['--namespace', namespace, 'get', reference.kind, reference.name,
          '--ignore-not-found=true', '-o', `go-template=${referenceProjection(reference.kind === 'PersistentVolumeClaim')}`]);
        if (!output.trim()) { results.push({ ...identity, status: 'missing' }); continue; }
        const projected = object(JSON.parse(output), ['kind', 'namespace', 'name', 'uid', 'keys', 'phase'], 'external reference projection');
        if (projected.kind !== reference.kind || projected.namespace !== namespace || projected.name !== reference.name || !Array.isArray(projected.keys)
          || projected.keys.at(-1) !== null || projected.keys.slice(0, -1).some(value => typeof value !== 'string')) throw new Error('External reference projection invalid.');
        results.push({ ...identity, status: 'present', uid: projected.uid as string, keys: [...new Set(projected.keys.slice(0, -1) as string[])].sort(),
          ...(reference.kind === 'PersistentVolumeClaim' ? { ready: projected.phase === 'Bound' } : {}) });
      } catch (error) {
        const forbidden = error instanceof Error && /\(Forbidden\)/.test(error.message);
        results.push({ ...identity, status: forbidden ? 'forbidden' : 'unknown' });
      }
    }
    return results;
  }
}

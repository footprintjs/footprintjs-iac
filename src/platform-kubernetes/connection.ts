import { createHash } from 'node:crypto';
import { jsonCopy } from '../graph/data.ts';
import { normalizeKubernetesTarget } from '../kubernetes-workload/target.ts';
import { name } from '../kubernetes-workload/validation.ts';
import { identifier } from '../platform-access/data.ts';
import { readBootstrapContext, readPublishedClusterAccess } from '../platform-bootstrap/data.ts';
import { sameCluster } from '../platform-bootstrap/connection.ts';
import type { BootstrapContext, ClusterConnectionPort, ClusterObservation, PublishedClusterAccess } from '../platform-bootstrap/types.ts';
import { readResourceHandle } from '../resource-flow/data.ts';
import type { ResourceHandle, VerificationResult } from '../resource-flow/types.ts';
import { fingerprint } from '../util.ts';
import { cniReady, namespaceIdentity, nodeName, nodesReady, object, systemPodsReady, version } from './readiness.ts';
import { createPinnedKubernetesReadonlyRunner } from './tls.ts';
import type { KubernetesReadResponse, KubernetesReadonlyRunner, PinnedKubernetesConnectionOptions } from './types.ts';

/** Existing registered cluster only. Certificate discovery/registration after creation is a separate host adapter. */
export class PinnedKubernetesClusterConnection implements ClusterConnectionPort {
  private readonly registration: ReturnType<typeof normalizeKubernetesTarget>;
  private readonly resource: ResourceHandle;
  private readonly expectedVersion: string;
  private readonly nodeNames: readonly string[];
  private readonly cni: PinnedKubernetesConnectionOptions['cni'];
  private readonly systemNamespace: string;
  private readonly cniPath: string;
  private readonly read: KubernetesReadonlyRunner;
  private readonly publisher?: NonNullable<PinnedKubernetesConnectionOptions['publishAccess']>;
  private profileId?: string;
  constructor(options: PinnedKubernetesConnectionOptions) {
    try {
      this.registration = Object.freeze(normalizeKubernetesTarget(jsonCopy(options.registration) as unknown as typeof options.registration));
      const ca = Buffer.from(options.ca);
      if (!ca.length || createHash('sha256').update(ca).digest('hex') !== this.registration.caSha256 || !!options.cert !== !!options.key) throw Error();
      this.expectedVersion = version(options.expectedVersion);
      const names = jsonCopy(options.expectedNodeNames) as unknown as string[];
      if (!Array.isArray(names) || !names.length || names.length > 128 || new Set(names).size !== names.length) throw Error();
      this.nodeNames = Object.freeze(names.map(nodeName).sort());
      const cni = jsonCopy(options.cni) as unknown as PinnedKubernetesConnectionOptions['cni'];
      if (!cni || Object.keys(cni).some(key => !['namespace', 'kind', 'name'].includes(key)) || !['DaemonSet', 'Deployment'].includes(cni.kind)) throw Error();
      this.cni = Object.freeze({ namespace: name(cni.namespace), kind: cni.kind, name: name(cni.name) });
      this.systemNamespace = name(options.systemNamespace ?? 'kube-system');
      this.cniPath = `/apis/apps/v1/namespaces/${this.cni.namespace}/${this.cni.kind === 'DaemonSet' ? 'daemonsets' : 'deployments'}/${this.cni.name}`;
      this.resource = readResourceHandle({ id: identifier(options.resourceId), kind: 'kubernetes-cluster',
        physicalId: 'kubernetes-' + fingerprint(this.registration), scope: identifier(options.scope) });
      if (options.expectedProfileId !== undefined) this.profileId = identifier(options.expectedProfileId);
      const paths = ['/version', '/readyz', '/api/v1/nodes', `/api/v1/namespaces/${this.registration.namespace}`,
        `/api/v1/namespaces/${this.systemNamespace}/pods`, this.cniPath];
      const timeoutMs = options.timeoutMs ?? 10000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw Error();
      const runner = options.runner ?? createPinnedKubernetesReadonlyRunner({ server: this.registration.apiServer, ca,
        ...(options.cert ? { cert: Buffer.from(options.cert), key: Buffer.from(options.key!) } : {}), token: options.token, timeoutMs }, paths);
      if (typeof runner !== 'function' || options.publishAccess !== undefined && typeof options.publishAccess !== 'function') throw Error();
      const allowed = new Set(paths);
      this.read = async path => {
        if (!allowed.has(path)) throw Error('Kubernetes readiness path refused');
        const response = await runner(path);
        if (!response || !Number.isSafeInteger(response.status)) throw Error();
        return { status: response.status, body: response.status === 200 ? jsonCopy(response.body) : null };
      };
      this.publisher = options.publishAccess?.bind(options);
    } catch { throw Error('Invalid pinned Kubernetes connection registration'); }
  }
  private async pinned(): Promise<boolean> {
    const response = await this.read(`/api/v1/namespaces/${this.registration.namespace}`);
    return response.status === 200 && namespaceIdentity(response.body, this.registration.namespace, this.registration.namespaceUid);
  }
  async inspect(context: BootstrapContext): Promise<ClusterObservation> {
    try {
      readBootstrapContext(context);
      if (!await this.pinned()) throw Error();
      const response = await this.read('/version');
      if (response.status !== 200) throw Error();
      const platformVersion = version(object(response.body).gitVersion);
      if (!await this.pinned()) throw Error();
      return { status: 'present', resource: this.resource, platformVersion };
    } catch { return { status: 'unknown' }; }
  }
  async publishAccess(input: ResourceHandle, context: BootstrapContext): Promise<PublishedClusterAccess | undefined> {
    try {
      const resource = readResourceHandle(input), observed = await this.inspect(context);
      if (!sameCluster(this.resource, resource) || observed.status !== 'present' || observed.platformVersion !== this.expectedVersion) throw Error();
      const published = readPublishedClusterAccess(await this.publisher?.(resource, readBootstrapContext(context)));
      if (published) {
        if (this.profileId && this.profileId !== published.profileId) throw Error();
        const after = await this.inspect(context);
        if (after.status !== 'present' || after.platformVersion !== this.expectedVersion) throw Error();
        this.profileId = published.profileId;
      }
      return published;
    } catch { throw Error('Kubernetes access publication unavailable'); }
  }
  async verify(input: ResourceHandle, profileId: string, context: BootstrapContext): Promise<VerificationResult> {
    const checks = ['api', 'nodes-ready', 'system-pods-ready', 'cni-ready'].map(id => ({ id, passed: false }));
    try {
      readBootstrapContext(context);
      if (!this.profileId || identifier(profileId) !== this.profileId || !sameCluster(readResourceHandle(input), this.resource) || !await this.pinned()) throw Error();
      const safe = async (path: string): Promise<KubernetesReadResponse> => { try { return await this.read(path); } catch { return { status: 0, body: null }; } };
      const [api, readiness, nodes, pods, cni] = await Promise.all(['/version', '/readyz', '/api/v1/nodes', `/api/v1/namespaces/${this.systemNamespace}/pods`, this.cniPath].map(safe));
      checks[0]!.passed = api!.status === 200 && version(object(api!.body).gitVersion) === this.expectedVersion
        && readiness!.status === 200 && typeof readiness!.body === 'string' && readiness!.body.trim() === 'ok';
      checks[1]!.passed = nodes!.status === 200 && nodesReady(nodes!.body, this.nodeNames, this.expectedVersion);
      checks[2]!.passed = pods!.status === 200 && systemPodsReady(pods!.body, this.systemNamespace);
      checks[3]!.passed = cni!.status === 200 && cniReady(cni!.body, this.cni);
      if (!await this.pinned()) for (const check of checks) check.passed = false;
    } catch { for (const check of checks) check.passed = false; }
    return { ok: checks.every(check => check.passed), checks };
  }
}

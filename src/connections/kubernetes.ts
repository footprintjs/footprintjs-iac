import { runKubectl, type CommandRunner } from '../providers/kubernetes.ts';
import type { JsonObject } from '../types.ts';
import { canonical } from '../util.ts';
import { ConnectionCheckError, type ConnectionAdapter, type ConnectionCheckRequest, type ConnectionObservation } from './types.ts';
import { HTTP_CONNECTION_SCRIPT } from './kubernetes/http-script.ts';
import { inspectRoute, list, record, resourceName, routeDetails } from './kubernetes/route.ts';

export interface KubernetesConnectionOptions {
  context: string; kubeconfig: string; namespace: string;
  container?: string; path?: string; timeoutMs?: number; runner?: CommandRunner; kubectl?: string;
}

export class KubernetesConnectionError extends ConnectionCheckError {
  constructor(message: string, details: JsonObject) {
    const probe = details.probe && typeof details.probe === 'object' && !Array.isArray(details.probe) ? details.probe : undefined;
    const observation = typeof details.target === 'string' && typeof probe?.observedAt === 'number' && typeof probe.latencyMs === 'number'
      ? { method: 'kubernetes-service-http', target: details.target, observedAt: probe.observedAt, latencyMs: probe.latencyMs, details }
      : undefined;
    super(message, observation, details);
  }
}

/** One-time DNS + HTTP observation through the real Service, from a ready target pod. */
export class KubernetesConnectionAdapter implements ConnectionAdapter {
  private readonly options: Readonly<Required<Omit<KubernetesConnectionOptions, 'runner'>>>;
  private readonly runner: CommandRunner;
  constructor(options: KubernetesConnectionOptions) {
    const selected = { ...options, container: options.container ?? 'node', path: options.path ?? '/health',
      timeoutMs: options.timeoutMs ?? 3000, kubectl: options.kubectl ?? 'kubectl' };
    if (![selected.context, selected.kubeconfig, selected.kubectl].every(value => typeof value === 'string' && value.trim()
      && !value.startsWith('-') && !/[\x00-\x1f\x7f]/.test(value))
      || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(selected.namespace)
      || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(selected.container)
      || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(selected.path) || selected.path.startsWith('//')
      || !Number.isInteger(selected.timeoutMs) || selected.timeoutMs < 100 || selected.timeoutMs > 30000) {
      throw new Error('Connection checks require explicit Kubernetes selectors and a bounded internal HTTP path');
    }
    this.options = Object.freeze({ context: selected.context, kubeconfig: selected.kubeconfig, namespace: selected.namespace,
      container: selected.container, path: selected.path, timeoutMs: selected.timeoutMs, kubectl: selected.kubectl });
    this.runner = selected.runner ?? runKubectl;
  }
  private async command(args: string[]): Promise<string> {
    const { context, kubeconfig, namespace, timeoutMs, kubectl } = this.options;
    const result = await this.runner(kubectl, ['--kubeconfig', kubeconfig, '--context', context, '--namespace', namespace,
      '--request-timeout', `${Math.ceil((timeoutMs + 1000) / 1000)}s`, ...args], { timeoutMs: timeoutMs + 2000 });
    return result.stdout;
  }
  private async route(request: ConnectionCheckRequest) {
    const { namespace, container } = this.options;
    const service = resourceName(request.from, 'Service', namespace), deployment = resourceName(request.to, 'Deployment', namespace);
    const read = async (args: string[]) => JSON.parse(await this.command(['get', ...args, '--output=json']));
    // Reads stay sequential so a failure never leaves background commands running after the check ends.
    const liveService = record(await read(['service', service]));
    const liveDeployment = record(await read(['deployment', deployment]));
    const replicaSets = list(await read(['replicasets']));
    const pods = list(await read(['pods']));
    const endpointSlices = list(await read(['endpointslices.discovery.k8s.io', '--selector', `kubernetes.io/service-name=${service}`]));
    return inspectRoute({ service: liveService, deployment: liveDeployment, replicaSets, pods, endpointSlices,
      from: request.from, to: request.to, stack: request.stack, namespace, container });
  }
  async check(original: ConnectionCheckRequest): Promise<ConnectionObservation> {
    const request = structuredClone(original);
    const { namespace, container, path, timeoutMs } = this.options;
    let details: JsonObject = { context: this.options.context, namespace,
      scope: 'One-time target-pod vantage point through Service DNS/ClusterIP to its owned Deployment backends; not arbitrary-client reachability or continuous traffic.' };
    try {
      const before = await this.route(request);
      const serviceName = resourceName(request.from, 'Service', namespace);
      const target = `http://${serviceName}.${namespace}.svc.cluster.local:${before.servicePort}${path}`;
      details = { ...details, target, before: routeDetails(before) };
      let probe: Record<string, any>;
      const probeStarted = Date.now();
      try {
        probe = record(JSON.parse(await this.command(['exec', before.sourcePod.name, '--container', container, '--', 'node', '-e',
          HTTP_CONNECTION_SCRIPT, JSON.stringify({ url: target, clusterIPs: before.clusterIPs, timeoutMs })])));
      } catch (error) {
        details.probe = { ok: false, stage: 'exec', observedAt: Date.now(), latencyMs: Date.now() - probeStarted,
          error: error instanceof Error ? error.message : String(error) };
        throw new KubernetesConnectionError(`In-cluster connection command failed: ${error instanceof Error ? error.message : String(error)}`, details);
      }
      details.probe = JSON.parse(JSON.stringify(probe));
      const after = await this.route(request);
      details.after = routeDetails(after);
      if (canonical(before) !== canonical(after)) throw new KubernetesConnectionError('Service routing or backend identity changed during the connection check', details);
      if (probe.ok !== true || probe.stage !== 'complete' || probe.httpStatus !== 200 || probe.responseStatus !== 'ok'
        || !Array.isArray(probe.addresses) || !probe.addresses.length || probe.addresses.some((ip: unknown) => !before.clusterIPs.includes(String(ip)))
        || !Number.isFinite(probe.latencyMs) || probe.latencyMs < 0 || !Number.isFinite(probe.observedAt)) {
        throw new KubernetesConnectionError(`Service connection failed: ${typeof probe.error === 'string' ? probe.error : 'unverified DNS/HTTP health response'}`, details);
      }
      return { method: 'kubernetes-service-http', target, observedAt: probe.observedAt, latencyMs: probe.latencyMs, details };
    } catch (error) {
      if (error instanceof KubernetesConnectionError) throw error;
      throw new KubernetesConnectionError(error instanceof Error ? error.message : String(error), details);
    }
  }
}

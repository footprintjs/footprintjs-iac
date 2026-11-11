import { join } from 'node:path';
import { canonical } from '../../src/util.ts';
import { jsonCopy } from '../../src/graph/data.ts';
import { runKubectl, type CommandRunner } from '../../src/providers/kubernetes.ts';
import { KubernetesConnectionAdapter } from '../../src/connections/kubernetes.ts';
import { ConnectionCheckError, type ConnectionAdapter, type ConnectionCheckRequest, type ConnectionObservation } from '../../src/connections/types.ts';
import type { JsonObject, ResourceAdapter } from '../../src/types.ts';
import { createIdentityGraph } from './graph.ts';
import { IdentityFixtureAdapter } from './docker-adapter.ts';
import { neoIdentityCheckAdapter, neoIdentityChecks, type NeoIdentityCheckOptions } from './checks.ts';
import { identityRoot, loadIdentityTarget, validateIdentityTarget, type IdentityTarget } from './target.ts';
import { assertFederationRoute, observeIdentityEndpoint, observeIdentityFixture } from './connections/fixture.ts';
import { observeIdentityPod } from './connections/pod.ts';
import { JWKS_CONNECTION_SCRIPT } from './connections/jwks-script.ts';
import { publicServiceDetails, publicServiceFailure } from './connections/service-failure.ts';

/** Trusted composition/test seams. Dashboard requests cannot select targets, transports or commands. */
export interface NeoIdentityConnectionOptions {
  runner?: CommandRunner;
  fixtureRoot?: string;
  loadTarget?: typeof loadIdentityTarget;
  fixtureAdapter?: Pick<ResourceAdapter, 'observe'>;
  identityOptions?: NeoIdentityCheckOptions;
}

const scope = {
  directory: 'An actual OIDC credential grant through the owned broker and its sealed, uncached LDAPS federation.',
  jwks: 'An HTTP signing-key request from a Ready owned Neo Pod to its declared owned broker address.',
  service: 'An in-cluster Service DNS/ClusterIP health request from a Ready owned Neo Pod to its owned backends.',
};
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Three measured communication paths over the exact prepared Neo identity graph. */
export async function neoIdentityConnectionAdapter(input: IdentityTarget, options: NeoIdentityConnectionOptions = {}): Promise<ConnectionAdapter> {
  const root = options.fixtureRoot ?? identityRoot;
  const target = validateIdentityTarget(input, root);
  if (!target.providerAddress) throw Error('Neo connection checks require the observed provider address');
  const graph = createIdentityGraph(target, { includeNeo: true });
  const resources = new Map(graph.resources.map(resource => [resource.id, resource]));
  const requests = new Map<string, string>(graph.relations.flatMap((relation, index) => relation.kind !== 'communicatesWith' ? [] : [[`communication:${index}`, canonical({
    connectionId: `communication:${index}`, stack: graph.name, from: resources.get(relation.from), to: resources.get(relation.to), relation,
  })] as const]));
  const runner = options.runner ?? runKubectl;
  const command = async (program: string, args: string[], timeout = 30000) => (await runner(program, args, { timeoutMs: timeout })).stdout.trim();
  const loader = options.loadTarget ?? ((path?: string) => loadIdentityTarget(path, { root, runner: command }));
  async function admitTarget() {
    const admitted = validateIdentityTarget(await loader(join(target.directory, 'target.json')), root);
    if (canonical(admitted) !== canonical(target)) throw Error('target-changed');
  }
  await admitTarget();
  const fixture = options.fixtureAdapter ?? new IdentityFixtureAdapter(target.id, command, root);
  const identity = await neoIdentityCheckAdapter(target, options.identityOptions);
  const authenticate = identity.check.bind(identity);
  const service = new KubernetesConnectionAdapter({ context: target.context, kubeconfig: target.kubeconfig, namespace: target.namespace, runner });
  const provider = resources.get('identity-provider')!, runtime = resources.get('neo-app')!;
  const jwksUrl = `http://${target.providerAddress}:8080/realms/neo/protocol/openid-connect/certs`;

  return { async check(original: ConnectionCheckRequest): Promise<ConnectionObservation> {
    const started = Date.now();
    let method = 'neo-identity-connection', endpoint = 'admitted Neo identity graph';
    let details: JsonObject = { context: target.context, namespace: target.namespace, code: 'request-rejected' };
    const observation = (): ConnectionObservation => ({ method, target: endpoint, observedAt: Date.now(), latencyMs: Date.now() - started, details });
    let failureCode = 'request-rejected';
    try {
      const request = jsonCopy(original) as unknown as ConnectionCheckRequest;
      if (requests.get(request.connectionId) !== canonical(request)) throw Error();
      failureCode = 'target-admission-failed'; await admitTarget();
      if (request.from.id === 'identity-provider') {
        method = 'oidc-ldaps-federation'; endpoint = `ldaps://${target.directoryName}:1636`;
        details = { context: target.context, namespace: target.namespace, scope: scope.directory };
        failureCode = 'identity-route-unverified'; await assertFederationRoute(target);
        const before = await observeIdentityFixture(target, graph.resources, graph.name, fixture, runner);
        details.before = json(before);
        failureCode = 'federated-login-failed';
        const result = await authenticate(neoIdentityChecks.find(check => check.id === 'login-alice')!);
        details.probe = { verdict: result.verdict, httpStatus: result.details?.httpStatus ?? null,
          protocol: result.details?.protocol ?? null, observedAt: result.observedAt, latencyMs: result.latencyMs, cachePolicy: 'NO_CACHE' };
        const after = await observeIdentityFixture(target, graph.resources, graph.name, fixture, runner); details.after = json(after);
        if (canonical(before) !== canonical(after)) { failureCode = 'identity-changed-during-check'; throw Error(); }
        if (!before.provider.running || !before.directory.running || result.verdict !== 'authenticated'
          || result.details?.httpStatus !== 200 || result.details.protocol !== 'oidc'
          || result.details.phase !== 'authentication' || !validTime(result.observedAt) || !validTime(result.latencyMs)) throw Error();
      } else if (request.from.id === 'neo-app') {
        method = 'kubernetes-pod-jwks-http'; endpoint = jwksUrl;
        details = { context: target.context, namespace: target.namespace, scope: scope.jwks };
        failureCode = 'source-or-destination-unverified';
        const before = { provider: await observeIdentityEndpoint(target, provider, graph.name, fixture, runner),
          source: await observeIdentityPod(target, runtime, graph.name, runner) }; details.before = json(before);
        failureCode = 'jwks-command-failed';
        const result = JSON.parse((await runner('kubectl', ['--kubeconfig', target.kubeconfig, '--context', target.context,
          '--namespace', target.namespace, '--request-timeout', '5s', 'exec', before.source.pod.name, '--container', 'node', '--',
          'node', '-e', JWKS_CONNECTION_SCRIPT, JSON.stringify({ url: jwksUrl, timeoutMs: 3000 })], { timeoutMs: 6000 })).stdout);
        details.probe = { httpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : null,
          code: ['verified', 'jwks-http-failed', 'jwks-response-invalid', 'jwks-response-too-large', 'jwks-signing-key-missing',
            'jwks-transport-failed', 'jwks-probe-failed', 'jwks-deadline-exceeded'].includes(result.code) ? result.code : 'unverified',
          signingKeys: Number.isInteger(result.signingKeys) ? result.signingKeys : 0,
          observedAt: validTime(result.observedAt) ? result.observedAt : null, latencyMs: validTime(result.latencyMs) ? result.latencyMs : null };
        failureCode = 'jwks-probe-failed';
        const after = { provider: await observeIdentityEndpoint(target, provider, graph.name, fixture, runner),
          source: await observeIdentityPod(target, runtime, graph.name, runner) }; details.after = json(after);
        if (canonical(before) !== canonical(after)) { failureCode = 'identity-changed-during-check'; throw Error(); }
        if (!before.provider.running || result.ok !== true || result.code !== 'verified' || result.httpStatus !== 200
          || !Number.isInteger(result.signingKeys) || result.signingKeys < 1 || result.signingKeys > 32
          || !validTime(result.observedAt) || !validTime(result.latencyMs)) throw Error();
      } else {
        method = 'kubernetes-service-http'; endpoint = `http://neo.${target.namespace}.svc.cluster.local:5230/health`;
        details = { context: target.context, namespace: target.namespace, scope: scope.service };
        failureCode = 'service-probe-failed';
        let result: ConnectionObservation;
        try { result = await service.check(request); }
        catch (error) { details = { ...details, ...publicServiceFailure(error) }; throw error; }
        details = { ...details, ...publicServiceDetails(result.details) };
        endpoint = result.target;
      }
      failureCode = 'target-changed-during-check'; await admitTarget();
      details.code = 'verified'; return observation();
    } catch {
      details.code = failureCode;
      throw new ConnectionCheckError('Neo identity connection check failed', observation(), details);
    }
  } };
}

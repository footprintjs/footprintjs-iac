import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { jsonCopy } from '../../src/graph/data.ts';
import type { IdentityTarget } from './target.ts';

export function validateIdentityTarget(input: unknown, root: string): IdentityTarget {
  try {
    const target = jsonCopy(input) as unknown as IdentityTarget;
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || Object.keys(target).some(key => !['version', 'id', 'directory', 'context', 'kubeconfig', 'namespace', 'stateDirectory', 'sourceDirectory', 'sourceCommit',
        'neoPort', 'providerPort', 'ldapPort', 'issuer', 'providerName', 'directoryName', 'fixtureDigest', 'providerAddress', 'images'].includes(key))
      || target.version !== 1 || !/^[a-f0-9]{8}$/.test(target.id)
      || !/^kind-footprint-iac-recording-[a-f0-9]{8}$/.test(target.context)
      || target.namespace !== `footprint-iac-identity-${target.id}` || target.directory !== resolve(root, target.id)
      || target.stateDirectory !== resolve(target.directory, 'state') || !/^[a-f0-9]{64}$/.test(target.fixtureDigest)
      || target.providerName !== `footprint-identity-${target.id}-provider` || target.directoryName !== `footprint-identity-${target.id}-directory`
      || target.issuer !== `http://127.0.0.1:${target.providerPort}/realms/neo`) throw Error();
    const ports = [target.neoPort, target.providerPort, target.ldapPort];
    if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== ports.length) throw Error();
    const suffix = target.context.slice(-8), core = resolve(root, '../..');
    if (target.kubeconfig !== resolve(core, '.artifacts/neo/fresh', suffix, 'kubeconfig')) throw Error();
    if (!target.images || Object.keys(target.images).sort().join(',') !== 'ldapImage,nodeImage,providerImage,pythonImage') throw Error();
    for (const [role, image] of [['node', target.images.nodeImage], ['python', target.images.pythonImage]] as const) {
      if (!/^sha256:[a-f0-9]{64}$/.test(image) && !new RegExp(`^footprint-iac/neo-${role}:(review|identity)-[a-f0-9]{64}$`).test(image)) throw Error();
    }
    if (![target.images.ldapImage, target.images.providerImage].every(image => /^sha256:[a-f0-9]{64}$/.test(image))) throw Error();
    if (target.sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(target.sourceCommit)) throw Error();
    if (target.sourceDirectory !== undefined && (typeof target.sourceDirectory !== 'string' || !target.sourceDirectory.startsWith('/') || /[\x00-\x1f\x7f]/.test(target.sourceDirectory))) throw Error();
    if (target.providerAddress !== undefined && (isIP(target.providerAddress) !== 4
      || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(target.providerAddress))) throw Error();
    return target;
  } catch { throw new Error('Invalid prepared identity target'); }
}

/** YAML is parsed locally before any executable may inspect or contact its target. */
export function identityApiPort(input: unknown, context: string): string {
  try {
    const config = input as { 'current-context'?: string; contexts?: { name: string; context: { cluster: string; user: string } }[];
      clusters?: { name: string; cluster: { server: string; 'certificate-authority-data'?: string; 'insecure-skip-tls-verify'?: boolean } }[];
      users?: { name: string; user: Record<string, unknown> }[] };
    if (!/^kind-footprint-iac-recording-[a-f0-9]{8}$/.test(context) || config['current-context'] !== context
      || config.contexts?.length !== 1 || config.clusters?.length !== 1 || config.users?.length !== 1
      || config.contexts[0]?.name !== context || config.clusters[0]?.name !== context || config.users[0]?.name !== context
      || config.contexts[0]?.context.cluster !== context || config.contexts[0]?.context.user !== context) throw Error();
    const cluster = config.clusters[0].cluster, user = config.users[0].user;
    if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(cluster.server) || !cluster['certificate-authority-data'] || cluster['insecure-skip-tls-verify']
      || Object.keys(user).some(key => !['client-certificate-data', 'client-key-data'].includes(key))
      || typeof user['client-certificate-data'] !== 'string' || !user['client-certificate-data']
      || typeof user['client-key-data'] !== 'string' || !user['client-key-data']) throw Error();
    const port = new URL(cluster.server).port;
    if (Number(port) < 1024 || Number(port) > 65535) throw Error();
    return port;
  } catch { throw new Error('Identity target requires its private single-context loopback credentials'); }
}

export function assertIdentityCluster(input: unknown, context: string, port: string): void {
  try {
    const containers = input as { Name: string; Config: { Labels: Record<string, string> }; State: { Running: boolean };
      HostConfig: { NetworkMode: string }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> } }[];
    const cluster = context.slice(5), container = containers[0];
    const bindings = container?.NetworkSettings?.Ports?.['6443/tcp'];
    if (!Array.isArray(containers) || containers.length !== 1 || container?.Name !== '/' + cluster + '-control-plane'
      || container.Config.Labels['io.x-k8s.kind.cluster'] !== cluster || container.Config.Labels['io.x-k8s.kind.role'] !== 'control-plane'
      || container.State.Running !== true || container.HostConfig.NetworkMode !== 'kind'
      || !Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1' || bindings[0].HostPort !== port) throw Error();
  } catch { throw new Error('Identity target cluster ownership and loopback API port do not match preparation'); }
}

import { canonical } from '../util.ts';
import { identifier, readHostContext, readHostRef } from './data.ts';
import { hostFactsDigest, readHostFactsSnapshot } from './facts.ts';
import { HOST_INVENTORY_ACTION, HOST_INVENTORY_ACTION_DIGEST } from './inventory-action.ts';
import type { HostAccessTransport, HostDiscoveryPort, HostFactsSnapshot, HostOperationContext, HostRef, HostToolObservation } from './types.ts';

const tools = ['kubeadm', 'kubelet', 'kubectl', 'containerd'] as const;
const keys = ['family', 'distribution', 'os_version', 'kernel', 'architecture', 'identity', 'cpu', 'memory_total', 'memory_available',
  'disk_total', 'disk_available', 'privilege', 'kubernetes', ...tools.flatMap(name => [name, `${name}-version`])];
const count = (value: string | undefined, zero = false, fractional = false): number | null => {
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= (zero ? 0 : Number.MIN_VALUE) && (fractional || Number.isSafeInteger(parsed)) ? parsed : null;
};
const text = (value: string | undefined): string | null => typeof value === 'string' && /^[-A-Za-z0-9_.+]{1,128}$/.test(value) ? value : null;
const tool = (values: Record<string, string>, name: string): HostToolObservation => {
  const state = values[name]; if (!['installed', 'absent', 'unknown'].includes(state!)) throw Error();
  const version = values[`${name}-version`];
  if (version && (state !== 'installed' || !/^v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9_.-]+)?$/.test(version))) throw Error();
  return { status: state as HostToolObservation['status'], ...(version ? { version } : {}) };
};
function unavailable(host: HostRef, observedAt: number): HostFactsSnapshot {
  const unknown = (): HostToolObservation => ({ status: 'unknown' });
  const base: Omit<HostFactsSnapshot, 'digest'> = { version: 1, kind: 'host-facts', host, observedAt, status: 'unavailable', identityDigest: null,
    os: { family: 'unknown', distribution: null, version: null, kernel: null }, architecture: 'unknown', cpuCount: null,
    memory: { totalBytes: null, availableBytes: null }, disk: { path: '/', totalBytes: null, availableBytes: null }, privilege: 'unknown',
    tools: { kubeadm: unknown(), kubelet: unknown(), kubectl: unknown(), containerd: unknown() }, kubernetes: { status: 'unknown' } };
  return readHostFactsSnapshot({ ...base, digest: hostFactsDigest(base) });
}
export function readHostInventoryOutput(output: string, hostInput: HostRef, observedAt = Date.now()): HostFactsSnapshot {
  const host = readHostRef(hostInput);
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output) > 16384 || /[\x00-\x08\x0b-\x1f\x7f]/.test(output)) throw Error();
    const lines = output.trimEnd().split('\n');
    if (lines.shift() !== 'footprint-host-inventory-v1' || lines.length !== keys.length) throw Error();
    const values: Record<string, string> = {};
    for (const line of lines) {
      const at = line.indexOf('='), key = line.slice(0, at);
      if (at <= 0 || !keys.includes(key) || Object.hasOwn(values, key)) throw Error();
      values[key] = line.slice(at + 1);
    }
    if (keys.some(key => !Object.hasOwn(values, key)) || !['linux', 'darwin', 'unknown'].includes(values.family!)
      || !['amd64', 'arm64', 'unknown'].includes(values.architecture!) || !['root', 'unprivileged', 'unknown'].includes(values.privilege!)
      || !['present', 'unknown'].includes(values.kubernetes!)) throw Error();
    const base: Omit<HostFactsSnapshot, 'digest'> = { version: 1, kind: 'host-facts', host, observedAt, status: 'partial',
      identityDigest: /^[a-f0-9]{64}$/.test(values.identity!) ? values.identity! : null,
      os: { family: values.family as HostFactsSnapshot['os']['family'], distribution: text(values.distribution), version: text(values.os_version), kernel: text(values.kernel) },
      architecture: values.architecture as HostFactsSnapshot['architecture'], cpuCount: count(values.cpu, false, true),
      memory: { totalBytes: count(values.memory_total), availableBytes: count(values.memory_available, true) },
      disk: { path: '/', totalBytes: count(values.disk_total), availableBytes: count(values.disk_available, true) },
      privilege: values.privilege as HostFactsSnapshot['privilege'],
      tools: { kubeadm: tool(values, 'kubeadm'), kubelet: tool(values, 'kubelet'), kubectl: tool(values, 'kubectl'), containerd: tool(values, 'containerd') },
      kubernetes: { status: values.kubernetes as 'present' | 'unknown' } };
    if (base.identityDigest && base.os.family !== 'unknown' && base.os.distribution && base.os.version && base.os.kernel
      && base.architecture !== 'unknown' && base.cpuCount !== null && base.memory.totalBytes !== null && base.memory.availableBytes !== null
      && base.disk.totalBytes !== null && base.disk.availableBytes !== null && base.privilege !== 'unknown' && base.kubernetes.status !== 'unknown'
      && Object.values(base.tools).every(tool => tool.status !== 'unknown' && (tool.status !== 'installed' || tool.version !== undefined))) base.status = 'complete';
    return readHostFactsSnapshot({ ...base, digest: hostFactsDigest(base) });
  } catch { return unavailable(host, observedAt); }
}

/** Only the exact library-owned read-only program is admitted as discovery. */
export class FixedHostDiscovery implements HostDiscoveryPort {
  readonly id: string;
  private readonly transport: HostAccessTransport;
  private readonly host: HostRef;
  constructor(options: { transport: HostAccessTransport; id?: string }) {
    this.id = identifier(options.id ?? 'fixed-host-discovery'); this.transport = options.transport;
    this.host = readHostRef(options.transport.host);
  }
  async inspect(hostInput: HostRef, context: HostOperationContext): Promise<HostFactsSnapshot> {
    const host = readHostRef(hostInput); readHostContext(context);
    if (canonical(host) !== canonical(this.host)) return unavailable(host, Date.now());
    try {
      const actions = this.transport.actions(), matches = actions.filter(action => action.id === HOST_INVENTORY_ACTION.id);
      if (matches.length !== 1 || matches[0]!.digest !== HOST_INVENTORY_ACTION_DIGEST || matches[0]!.effect !== 'read-only') throw Error();
      const result = await this.transport.run(HOST_INVENTORY_ACTION.id, context);
      return readHostInventoryOutput(result.stdout, host);
    } catch { return unavailable(host, Date.now()); }
  }
}

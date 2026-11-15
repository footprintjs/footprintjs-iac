import { canonical, fingerprint } from '../util.ts';
import { identifier, readHostContext, readHostRef } from './data.ts';
import { HostAccessError } from './error.ts';
import { readHostFactsSnapshot } from './facts.ts';
import type { HostDiscoveryPort, HostFactsSnapshot, HostOperationContext, HostRef } from './types.ts';

export interface HostDiscoveryRegistryOptions {
  id?: string;
  registrations: readonly { host: HostRef; discovery: HostDiscoveryPort }[];
}
/** Dispatch by exact immutable host registration, never by tool or provider brands. */
export class HostDiscoveryRegistry implements HostDiscoveryPort {
  readonly id: string;
  readonly digest: string;
  private readonly registry = new Map<string, { host: HostRef; inspect: HostDiscoveryPort['inspect'] }>();
  constructor(options: HostDiscoveryRegistryOptions) {
    const id = identifier(options.id ?? 'host-discovery-registry');
    if (id.length > 120 || !Array.isArray(options.registrations) || !options.registrations.length || options.registrations.length > 128) throw new HostAccessError('invalid-host-access');
    const bindings = [];
    for (const entry of options.registrations) {
      const host = readHostRef(entry.host), adapterId = identifier(entry.discovery?.id);
      if (typeof entry.discovery.inspect !== 'function' || this.registry.has(host.id)) throw new HostAccessError('invalid-host-access');
      this.registry.set(host.id, { host, inspect: entry.discovery.inspect.bind(entry.discovery) });
      bindings.push({ host, adapterId });
    }
    bindings.sort((a, b) => a.host.id.localeCompare(b.host.id));
    this.digest = fingerprint({ version: 1, id, bindings }); this.id = `${id}:${this.digest}`;
  }
  async inspect(input: HostRef, context: HostOperationContext): Promise<HostFactsSnapshot> {
    const host = readHostRef(input), admittedContext = readHostContext(context), entry = this.registry.get(host.id);
    if (!entry || canonical(entry.host) !== canonical(host)) throw new HostAccessError('host-action-not-admitted');
    try {
      const facts = readHostFactsSnapshot(await entry.inspect(host, admittedContext));
      if (canonical(facts.host) !== canonical(host)) throw Error();
      return facts;
    } catch { throw new HostAccessError('host-access-unavailable'); }
  }
}

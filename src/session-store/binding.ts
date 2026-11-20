import type { CapabilityAdapter, SupportContext } from '../binding/types.ts';
import type { Capability } from '../system/types.ts';
import type { JsonObject } from '../types.ts';

const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function absoluteMillis(expiration: JsonObject): number | undefined {
  if (Object.keys(expiration).length !== 1 || typeof expiration.absolute !== 'string') return;
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(expiration.absolute);
  if (!match) return;
  const millis = Number(match[1]) * units[match[2]!]!;
  if (Number.isSafeInteger(millis)) return millis;
}

function consumers(context: SupportContext, store: Capability) {
  if (!context.storeUses) throw new Error('Session storage requires workload access declarations');
  return context.storeUses({ kind: 'store', path: store.path });
}

/** Pure compiler extension. Credentials and open connections stay outside the graph. */
export function sessionCapabilityAdapter(provider: string): CapabilityAdapter {
  const reasons: Record<string, string> = {
    purpose: 'Sessions can be issued, read by token and revoked.',
    dataModel: 'Each opaque token addresses one session value.',
    expiration: 'The issuer caps the lifetime and the backend enforces the absolute deadline.',
  };
  return {
    id: provider, mode: 'real',
    supports(store, context) {
      const unsupported = new Set<string>();
      if (store.kind !== 'store' || store.properties.purpose !== 'session') unsupported.add('purpose');
      if (store.properties.dataModel !== 'keyValue') unsupported.add('dataModel');
      const requirements = Object.entries(store.properties).flatMap(([property, requested]) => {
        if (!Object.hasOwn(reasons, property) || (property === 'expiration' && !absoluteMillis(requested as JsonObject))) {
          unsupported.add(property);
          return [];
        }
        return [{ property, requested, status: 'implemented' as const, reason: reasons[property]! }];
      });
      if (store.kind === 'store') {
        for (const use of consumers(context, store)) {
          if (use.access !== 'read' || use.kind !== 'service') unsupported.add(use.workloadId + '.' + use.access);
        }
      }
      return { supported: !unsupported.size, unsupportedRequirements: [...unsupported], requirements,
        reason: 'Supports key-value sessions, absolute expiry, revocation and read-only service access.' };
    },
    lower(store, context) {
      const id = context.resourceId();
      const expiration = store.properties.expiration as JsonObject | undefined;
      const spec = { kind: 'SessionStore', purpose: 'session', dataModel: 'keyValue',
        readers: consumers(context, store).map(use => use.workloadId),
        ...(expiration && { maxLifetimeMs: absoluteMillis(expiration)! }) };
      return { resources: [{ id, provider, spec }], propertyOrigins: [
        { property: 'purpose', resourceId: id, path: '/purpose' },
        { property: 'dataModel', resourceId: id, path: '/dataModel' },
        ...(expiration ? [{ property: 'expiration', resourceId: id, path: '/maxLifetimeMs' }] : []),
      ] };
    },
  };
}

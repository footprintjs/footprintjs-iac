import { freeze, jsonCopy } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import { HostAccessError } from './error.ts';
import type { HostAction, HostActionDescriptor, HostOperationContext, HostRef } from './types.ts';

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[-A-Za-z0-9_.:]{1,256}$/.test(value)) throw new HostAccessError('invalid-host-access');
  return value;
}
export function readHostRef(input: unknown): HostRef {
  try {
    const value = jsonCopy(input) as Record<string, unknown>;
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'scope', 'profileId'].includes(key))) throw Error();
    return freeze({ id: identifier(value.id), scope: identifier(value.scope), profileId: identifier(value.profileId) });
  } catch { throw new HostAccessError('invalid-host-access'); }
}
export function readHostContext(input: HostOperationContext): HostOperationContext {
  try {
    const value = jsonCopy(input) as unknown as Record<string, unknown>;
    if (!value || Object.keys(value).some(key => !['executionId', 'operationId', 'expectedIdentityDigest'].includes(key))) throw Error();
    if (value.expectedIdentityDigest !== undefined && (typeof value.expectedIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedIdentityDigest))) throw Error();
    return { executionId: identifier(value.executionId), operationId: identifier(value.operationId),
      ...(value.expectedIdentityDigest ? { expectedIdentityDigest: value.expectedIdentityDigest as string } : {}) };
  } catch { throw new HostAccessError('invalid-host-access'); }
}
export function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new HostAccessError('invalid-host-access');
  return value as number;
}
export function hostActionDigest(action: HostAction): string { return fingerprint({ id: action.id, script: action.script, effect: action.effect }); }
export function registerHostActions(actions: readonly HostAction[]): Map<string, Readonly<HostAction & HostActionDescriptor>> {
  try {
    const values = jsonCopy(actions) as unknown as HostAction[];
    if (!Array.isArray(values) || !values.length || values.length > 64) throw Error();
    const registry = new Map<string, Readonly<HostAction & HostActionDescriptor>>();
    for (const action of values) {
      if (!action || Object.keys(action).some(key => !['id', 'script', 'effect'].includes(key))
        || typeof action.script !== 'string' || !action.script || action.script.length > 65536 || action.script.includes('\0')
        || !['read-only', 'mutating'].includes(action.effect)) throw Error();
      const id = identifier(action.id); if (registry.has(id)) throw Error();
      registry.set(id, freeze({ ...action, digest: hostActionDigest(action) }));
    }
    return registry;
  } catch { throw new HostAccessError('invalid-host-access'); }
}

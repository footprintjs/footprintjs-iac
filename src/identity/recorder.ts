import type { EmitEvent } from 'footprintjs';
import { freeze, identifier, keys } from '../graph/data.ts';
import { readAccessObservation, readIdentityCheck } from './data.ts';
import { plainRecord } from './values.ts';
import { IDENTITY_EVENT, type IdentityEvent, type IdentityRecorder, type IdentitySnapshot } from './types.ts';

function readEvent(native: EmitEvent, sequence: number): IdentityEvent | undefined {
  try {
    const row = plainRecord(native.payload, 'identity event');
    keys(row, ['version', 'runId', 'checkId', 'label', 'kind', 'expected', 'status', 'observation', 'message'], 'identity event');
    if (row.version !== 1 || typeof row.runId !== 'string' || !row.runId
      || !['checking', 'passed', 'failed'].includes(String(row.status))
      || !Number.isFinite(native.timestamp) || typeof native.runtimeStageId !== 'string' || !native.runtimeStageId) return undefined;
    const request = readIdentityCheck({ id: row.checkId, label: row.label, kind: row.kind, expected: row.expected });
    const observation = row.observation === undefined ? undefined : readAccessObservation(row.observation);
    if (row.status === 'checking' && (observation || row.message !== undefined)) return undefined;
    if (row.status !== 'checking' && (!observation || (observation.verdict === request.expected) !== (row.status === 'passed'))) return undefined;
    const message = row.status === 'failed' && observation ? `Observed ${observation.verdict}; expected ${request.expected}.` : undefined;
    if (row.message !== message) return undefined;
    return freeze({ version: 1, runId: row.runId, sequence, checkId: request.id, label: request.label, kind: request.kind, expected: request.expected,
      status: row.status, timestamp: native.timestamp, runtimeStageId: native.runtimeStageId,
      ...(observation ? { observation } : {}), ...(message ? { message } : {}) } as IdentityEvent);
  } catch { return undefined; }
}
export function createIdentityRecorder(options: { id?: string } = {}): IdentityRecorder {
  const id = identifier(options.id ?? 'iac-identity-progress', 'identity recorder id');
  let runId: string | null = null, sequence = 0, ignoredEvents = 0, subscriberFailures = 0;
  const checks = new Map<string, IdentityEvent>(); const events: IdentityEvent[] = [];
  const listeners = new Set<(event: IdentityEvent) => void>();
  const getSnapshot = (): IdentitySnapshot => freeze({ version: 1, runId, sequence, checks: Object.fromEntries(checks), events: [...events], ignoredEvents, subscriberFailures });
  return {
    id,
    clear() { runId = null; sequence = 0; ignoredEvents = 0; subscriberFailures = 0; checks.clear(); events.length = 0; },
    onEmit(native) {
      if (native.name !== IDENTITY_EVENT) return;
      const event = readEvent(native, sequence + 1);
      if (!event || (runId !== null && event.runId !== runId)) { ignoredEvents++; return; }
      runId = event.runId; sequence = event.sequence; checks.set(event.checkId, event); events.push(event);
      for (const listener of listeners) { try { listener(event); } catch { subscriberFailures++; } }
    },
    getSnapshot,
    getEvents(afterSequence = 0) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Identity cursor must be a nonnegative safe integer');
      return Object.freeze(events.filter(event => event.sequence > afterSequence));
    },
    subscribe(listener) { if (typeof listener !== 'function') throw new Error('An identity subscriber must be a function'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    toSnapshot() { return { name: 'Identity and access checks', data: getSnapshot(), description: 'Recorded adapter observations compared to declared expectations; a denied-access check passes only when access is actually denied.' }; },
  };
}

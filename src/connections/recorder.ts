import type { EmitEvent } from 'footprintjs';
import { freeze, jsonCopy } from '../graph/data.ts';
import { readConnectionObservation } from './data.ts';
import { CONNECTION_EVENT, type ConnectionEvent, type ConnectionRecorder, type ConnectionSnapshot } from './types.ts';

function readEvent(native: EmitEvent, sequence: number): ConnectionEvent | undefined {
  try {
    const payload = jsonCopy(native.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const { runId, connectionId, from, to, status, message, observation, details } = payload;
    if (payload.version !== 1 || [runId, connectionId, from, to].some(value => typeof value !== 'string' || !value)
      || typeof status !== 'string' || !['checking', 'connected', 'failed'].includes(status)
      || (message !== undefined && typeof message !== 'string')
      || (details !== undefined && (!details || typeof details !== 'object' || Array.isArray(details)))
      || !Number.isFinite(native.timestamp) || typeof native.runtimeStageId !== 'string' || !native.runtimeStageId
      || (status === 'connected' && observation === undefined)) return undefined;
    const observed = observation === undefined ? undefined : readConnectionObservation(observation);
    return freeze({ version: 1, sequence, runId, connectionId, from, to, status,
      timestamp: native.timestamp, runtimeStageId: native.runtimeStageId,
      ...(message === undefined ? {} : { message }), ...(observed ? { observation: observed } : {}),
      ...(details === undefined ? {} : { details }) } as ConnectionEvent);
  } catch { return undefined; }
}

/** Projection over native emits. No timer or resource readiness can create a connection outcome. */
export function createConnectionRecorder(options: { id?: string } = {}): ConnectionRecorder {
  const id = options.id ?? 'iac-connection-progress';
  if (typeof id !== 'string' || !id.trim()) throw new Error('A connection recorder needs a nonempty ID');
  let runId: string | null = null, sequence = 0, ignoredEvents = 0, subscriberFailures = 0;
  const connections = new Map<string, ConnectionEvent>();
  const events: ConnectionEvent[] = [];
  const listeners = new Set<(event: ConnectionEvent) => void>();
  const getSnapshot = (): ConnectionSnapshot => freeze({ version: 1, runId, sequence,
    connections: Object.fromEntries(connections), events: [...events], ignoredEvents, subscriberFailures });
  return {
    id,
    clear() { runId = null; sequence = 0; ignoredEvents = 0; subscriberFailures = 0; connections.clear(); events.length = 0; },
    onEmit(native) {
      if (native.name !== CONNECTION_EVENT) return;
      const event = readEvent(native, sequence + 1);
      if (!event || (runId !== null && event.runId !== runId)) { ignoredEvents++; return; }
      runId = event.runId; sequence = event.sequence; connections.set(event.connectionId, event); events.push(event);
      for (const listener of listeners) { try { listener(event); } catch { subscriberFailures++; } }
    },
    getSnapshot,
    getEvents(afterSequence = 0) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Connection cursor must be a nonnegative safe integer');
      return Object.freeze(events.filter(event => event.sequence > afterSequence));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('A connection subscriber must be a function');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    toSnapshot() { return { name: 'IaC connection checks', data: getSnapshot(), description: 'Real point-in-time adapter observations; connected is never inferred from resource readiness.' }; },
  };
}

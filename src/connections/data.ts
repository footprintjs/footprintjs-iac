import { freeze, jsonCopy } from '../graph/data.ts';
import type { JsonObject } from '../types.ts';
import type { ConnectionObservation } from './types.ts';

/** Refuse accessors, non-JSON observations and invalid success data before publishing connected. */
export function readConnectionObservation(value: unknown): ConnectionObservation {
  const copy = jsonCopy(value) as unknown as ConnectionObservation;
  if (!copy || Array.isArray(copy) || typeof copy !== 'object'
    || typeof copy.method !== 'string' || !copy.method.trim()
    || typeof copy.target !== 'string' || !copy.target.trim()
    || !Number.isFinite(copy.observedAt) || copy.observedAt < 0
    || !Number.isFinite(copy.latencyMs) || copy.latencyMs < 0
    || !copy.details || typeof copy.details !== 'object' || Array.isArray(copy.details)) {
    throw new Error('Connection adapter returned an invalid observation');
  }
  return freeze(copy);
}

/** Failure evidence is optional. Invalid evidence cannot replace the original failed outcome. */
export function connectionErrorDetails(error: unknown): JsonObject | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'details');
  if (!descriptor || !('value' in descriptor)) return undefined;
  try {
    const details = jsonCopy(descriptor.value);
    return details && typeof details === 'object' && !Array.isArray(details) ? freeze(details) : undefined;
  } catch { return undefined; }
}

export function connectionErrorObservation(error: unknown): ConnectionObservation | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'observation');
  if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) return undefined;
  try { return readConnectionObservation(descriptor.value); } catch { return undefined; }
}

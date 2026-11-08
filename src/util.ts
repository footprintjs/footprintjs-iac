import { createHash } from 'node:crypto';
import type { Json, Resource } from './types.ts';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function operationId(stack: string, resource: Resource, action: string): string {
  return fingerprint({ stack, id: resource.id, provider: resource.provider, action, spec: resource.spec });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Project live provider data onto explicitly declared object fields, retaining whole declared arrays. */
export function project(actual: Json | undefined, desired: Json): Json {
  if (desired === null || typeof desired !== 'object' || Array.isArray(desired)) return actual ?? null;
  const result: Record<string, Json> = {};
  for (const [key, value] of Object.entries(desired)) {
    result[key] = project(actual && typeof actual === 'object' && !Array.isArray(actual) ? actual[key] : undefined, value);
  }
  return result;
}

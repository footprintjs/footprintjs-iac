import type { JsonObject } from '../types.ts';

export function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid or unsupported ${label}.`);
  return value as Record<string, unknown>;
}
export function name(value: unknown, label = 'Kubernetes name'): string {
  if (typeof value !== 'string' || value.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}
export function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,253}$/.test(value)) throw new Error('Invalid Kubernetes reference key.');
  return value;
}
export function image(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('Container image requires an immutable registry/repository@sha256 digest.');
  }
  return value;
}
export function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${label}.`);
  return value as number;
}
export function port(value: unknown): number { return integer(value, 1, 65535, 'port'); }
export function targetPort(value: unknown): number | string { return typeof value === 'string' ? name(value, 'port name') : port(value); }
export function protocol(value: unknown): string {
  if (value !== undefined && value !== 'TCP' && value !== 'UDP') throw new Error('Unsupported port protocol.');
  return value === undefined ? 'TCP' : value;
}
export function list(value: unknown, label: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 256) throw new Error(`Invalid ${label}.`);
  return value;
}
export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
}
export function relativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !value || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid relative volume path.');
  return value;
}
export function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:m|[KMGTPE]i?|[kmun])?$/.test(value)) throw new Error('Invalid resource quantity.');
  return value;
}
export function asJson(value: unknown): JsonObject { return value as JsonObject; }

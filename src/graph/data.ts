import type { Json, JsonObject } from '../types.ts';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export function identifier(value: unknown, where: string): string {
  if (typeof value !== 'string' || !namePattern.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    throw new Error(`Invalid ${where}: expected a safe stable identifier`);
  }
  return value;
}
export function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error(`Invalid ${where}: expected a string`);
  return value;
}
export function object(value: Json, where: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${where}: expected an object`);
  return value;
}
export function array(value: Json | undefined, where: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${where}: expected an array`);
  if (value.length > 10_000) throw new Error(`Too many entries in ${where}`);
  return value;
}
export function keys(value: JsonObject, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${where} field: ${key}`);
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Detach plain JSON without invoking accessors, dropping values, or changing prototype fields. */
export function jsonCopy(input: unknown): Json {
  const active = new Set<object>();
  let remaining = 100_000;
  function copy(value: unknown, depth: number): Json {
    if (--remaining < 0 || depth > 64) throw new Error('Graph JSON exceeds capture limits');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') throw new Error('Graph definitions must contain only finite JSON values');
    if (active.has(value)) throw new Error('Cyclic graph JSON value');
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error('Graph definitions require plain JSON objects');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Graph definitions cannot contain symbol properties');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let result: Json;
    if (Array.isArray(value)) {
      const output: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('Graph arrays must be dense JSON data');
        output.push(copy(descriptor.value, depth + 1));
      }
      if (Object.keys(descriptors).some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw new Error('Graph arrays cannot have extra properties');
      result = output;
    } else {
      const output: JsonObject = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('Graph definitions cannot contain accessors or hidden properties');
        Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      result = output;
    }
    active.delete(value);
    return result;
  }
  return copy(input, 0);
}

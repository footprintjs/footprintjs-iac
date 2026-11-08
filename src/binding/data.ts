import { jsonCopy, object, text } from '../graph/data.ts';
import type { Json, JsonObject } from '../types.ts';

/** Inspect callback-bearing objects without running accessors. */
export function slots(input: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid ' + where);
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) throw new Error(where + ' must be a plain object');
  if (Object.getOwnPropertySymbols(input).length) throw new Error(where + ' cannot have symbols');
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!allowed.includes(key)) throw new Error('Unknown ' + where + ' field: ' + key);
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error(where + ' cannot have accessors or hidden properties');
    result[key] = descriptor.value;
  }
  return result;
}
export function list(input: unknown, where: string): unknown[] {
  const copied = jsonCopy(input);
  if (!Array.isArray(copied) || copied.length > 10_000) throw new Error('Invalid ' + where);
  return copied;
}
export function jsonObject(input: unknown, where: string): JsonObject { return object(jsonCopy(input), where); }
export function reason(input: unknown, where: string): string {
  const value = text(input, where);
  if (!value.trim()) throw new Error(where + ' cannot be empty');
  return value;
}
export function synchronousCallback(value: unknown, where: string): (...args: never[]) => unknown {
  if (typeof value !== 'function') throw new Error(where + ' must be a function');
  const name = Object.getPrototypeOf(value)?.constructor?.name;
  if (name === 'AsyncFunction' || name === 'AsyncGeneratorFunction' || name === 'GeneratorFunction') {
    throw new Error(where + ' must be synchronous; no adapter callback was invoked');
  }
  return value as (...args: never[]) => unknown;
}
export function synchronousResult(value: unknown, where: string): Json {
  if (value instanceof Promise) {
    void value.catch(() => undefined);
    throw new Error(where + ' returned a Promise; binding must be synchronous');
  }
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    throw new Error(where + ' returned a thenable; binding must be synchronous');
  }
  return jsonCopy(value);
}

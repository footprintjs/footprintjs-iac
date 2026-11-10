import { array, jsonCopy, object } from '../graph/data.ts';

/** Exact values only: no pattern language, control characters, or ambiguous edge whitespace. */
export function exactValue(input: unknown, where: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 256 || input.trim() !== input
    || /[\x00-\x1f\x7f*?]/.test(input) || ['__proto__', 'constructor', 'prototype'].includes(input)) {
    throw new Error(`Invalid ${where}: expected a bounded exact value`);
  }
  return input;
}
export function exactValues(input: unknown, where: string, allowEmpty = false): readonly string[] {
  const entries = array(jsonCopy(input), where);
  if ((!allowEmpty && entries.length === 0) || entries.length > 256) throw new Error(`Invalid ${where}: invalid entry count`);
  const result = entries.map(value => exactValue(value, where));
  if (new Set(result).size !== result.length) throw new Error(`Invalid ${where}: duplicate entries`);
  return result;
}
export function plainRecord(input: unknown, where: string) { return object(jsonCopy(input), where); }

import type { JsonObject } from '../types.ts';
import { identifier, jsonCopy, keys, object, text } from '../graph/data.ts';

export function choice<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`Invalid ${where}`);
  return value as T;
}
export function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${where}: expected a positive safe integer`);
  return value as number;
}
export function duration(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*(ms|s|m|h|d)$/.test(value)
    || !Number.isSafeInteger(Number(value.replace(/[a-z]+$/, '')))) throw new Error('Duration must be a positive integer followed by ms, s, m, h or d');
  return value;
}
export function durationFields(input: unknown, fields: readonly string[], where: string): JsonObject {
  const row = object(jsonCopy(input), where);
  keys(row, fields, where);
  if (!Object.keys(row).length) throw new Error(`${where} requires at least one field`);
  for (const [key, value] of Object.entries(row)) row[key] = duration(value);
  return row;
}
export function retentionValue(input: unknown): JsonObject {
  const row = object(jsonCopy(input), 'retention');
  keys(row, ['onRemoval', 'period'], 'retention');
  if (!Object.keys(row).length) throw new Error('Retention requires at least one field');
  if (row.onRemoval !== undefined) choice(row.onRemoval, ['retain', 'delete'], 'removal retention');
  if (row.period !== undefined) duration(row.period);
  return row;
}
export function replicationValue(input: unknown): JsonObject {
  const row = object(jsonCopy(input), 'replication');
  keys(row, ['copies'], 'replication');
  positiveInteger(row.copies, 'replication copies');
  return row;
}
export function purposeValue(input: unknown): string {
  const value = text(input, 'purpose');
  if (!value.trim() || value.length > 128) throw new Error('Purpose requires a nonempty short string');
  return value;
}

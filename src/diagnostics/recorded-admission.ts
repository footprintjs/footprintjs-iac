import type { CommitBundle } from 'foottrace';
import type { RecordedDependencyInput, RecordedDependencyOptions, RecordedDependencyProvenance } from './recorded-types.ts';

const limits = { commits: 10000, rows: 60000, executions: 20000, readKeys: 60000, values: 200000, inputBytes: 8 * 1024 * 1024 };
export const RECORDED_QUERY_LIMITS = Object.freeze({ maxNodes: 160, maxDepth: 32, maxEdges: 4096, maxOutputBytes: 256 * 1024 });
export class RecordedQueryError extends Error {
  readonly code: 'invalid-recording' | 'query-limit';
  constructor(code: 'invalid-recording' | 'query-limit') {
    super(code === 'query-limit' ? 'The recorded query exceeds its limits' : 'The recording cannot be inspected'); this.code = code;
  }
}
function invalid(): never { throw new RecordedQueryError('invalid-recording'); }
function over(): never { throw new RecordedQueryError('query-limit'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value); if (proto !== null && proto !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}
function own(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key); if (!field) return undefined;
  if (!('value' in field)) invalid(); return field.value;
}
function name(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) invalid(); return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)) invalid(); if (value.length > maximum) over();
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index) || !('value' in Object.getOwnPropertyDescriptor(value, String(index))!)) invalid();
  return value;
}
function metadata(value: unknown): void {
  // Bound public commit payload work without following raw sharedState, args, provider objects or read values.
  const stack = [value], seen = new Set<object>(); let count = 0, bytes = 0;
  while (stack.length) {
    if (++count > limits.values) over();
    const item = stack.pop();
    if (typeof item === 'string') { bytes += item.length * 3; if (bytes > limits.inputBytes) over(); continue; }
    if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean' || typeof item === 'bigint') continue;
    if (typeof item !== 'object') invalid(); if (seen.has(item)) continue; seen.add(item);
    if (Array.isArray(item)) { for (const entry of array(item, limits.values)) stack.push(entry); }
    else {
      object(item);
      for (const key of Object.keys(item)) { bytes += key.length * 3; stack.push(own(item, key)); }
    }
    if (bytes > limits.inputBytes) over();
  }
}
function treeBudget(value: unknown): void {
  const stack = Array.isArray(value) ? [...array(value, limits.executions)] : [value], seen = new Set<object>(); let count = 0, reads = 0;
  while (stack.length) {
    const node = object(stack.pop()); if (seen.has(node)) continue; seen.add(node);
    if (++count > limits.executions) over();
    const id = own(node, 'runtimeStageId'); if (id !== undefined) name(id);
    const keys = own(node, 'stageReads');
    if (keys !== undefined) for (const key of Object.keys(object(keys))) { name(key); if (++reads > limits.readKeys) over(); }
    const next = own(node, 'next'); if (next !== undefined) stack.push(next);
    const children = own(node, 'children'); if (children !== undefined) stack.push(...array(children, limits.executions));
    const branches = own(node, 'branches');
    if (branches !== undefined) for (const branch of array(branches, limits.executions)) stack.push(...array(branch, limits.executions));
  }
}
export function recordedQueryOptions(input: RecordedDependencyOptions = {}): Required<RecordedDependencyOptions> {
  const result: Required<RecordedDependencyOptions> = { ...RECORDED_QUERY_LIMITS };
  for (const key of Object.keys(result) as (keyof RecordedDependencyOptions)[]) {
    const value = own(input, key); if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > result[key]) over();
    result[key] = value as number;
  }
  return result;
}
export function admitRecordedQuery(input: RecordedDependencyInput, key: string) {
  name(key, 2048); const envelope = object(input), snapshot = object(own(envelope, 'snapshot'));
  const rawRunId = own(snapshot, 'runId'), runId = rawRunId === undefined ? null : name(rawRunId, 256);
  const log = array(own(snapshot, 'commitLog'), limits.commits);
  let rows = 0, readKeys = 0, withReadPrefix = 0, withoutReadPrefix = 0;
  for (const item of log) {
    const bundle = object(item);
    for (const field of ['runtimeStageId', 'stageId', 'stage']) {
      const value = own(bundle, field); if (value !== undefined) name(value);
    }
    const id = own(bundle, 'runtimeStageId'); if (typeof id !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(id)) invalid();
    for (const rowValue of array(own(bundle, 'trace'), limits.rows)) {
      if (++rows > limits.rows) over(); const row = object(rowValue); name(own(row, 'path'));
      const prefix = own(row, 'readKeys');
      if (prefix === undefined) withoutReadPrefix++;
      else {
        withReadPrefix++;
        for (const read of array(prefix, limits.readKeys)) { name(read); if (++readKeys > limits.readKeys) over(); }
      }
    }
  }
  metadata(log);
  const tree = own(snapshot, 'executionTree'); treeBudget(tree);
  const controls = own(envelope, 'controlDeps'), control = controls === undefined ? undefined : object(controls);
  if (control) {
    const entries = Object.keys(control); if (entries.length > limits.executions) over();
    for (const id of entries) {
      name(id); const selected = object(own(control, id)); name(own(selected, 'deciderId'));
      const label = own(selected, 'label'); if (label !== undefined) name(label);
    }
  }
  const recorded = own(snapshot, 'writeProvenance');
  const provenance: RecordedDependencyProvenance = { requested: 'per-write', recorded: recorded === 'reads-prefix' || recorded === 'off' ? recorded : 'unknown', withReadPrefix, withoutReadPrefix };
  return { log: log as CommitBundle[], tree, control, runId, provenance };
}

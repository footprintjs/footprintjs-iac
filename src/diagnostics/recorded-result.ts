import { HONESTY_CODES } from 'foottrace';
import { RECORDED_QUERY_LIMITS } from './recorded-admission.ts';
import type { RecordedDependencyResult } from './recorded-types.ts';

function refuse(): never { throw Error('Invalid recorded dependency result'); }
function object(input: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse();
  const result = input as Record<string, unknown>;
  if (fields && Object.keys(result).some(key => !fields.includes(key))) refuse(); return result;
}
function text(input: unknown, maximum = 2048): string {
  if (typeof input !== 'string' || input.length > maximum || input.includes('\u0000')) refuse(); return input;
}
function count(input: unknown, maximum = 60000): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0 || (input as number) > maximum) refuse(); return input as number;
}
function choice(input: unknown, choices: readonly string[]): string {
  const value = text(input); if (!choices.includes(value)) refuse(); return value;
}
function array(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) refuse(); return input;
}
function texts(input: unknown, maximum = 60000) { for (const item of array(input, maximum)) text(item); }
function coverage(input: unknown) {
  const value = object(input, ['steps', 'stepsWithReads']);
  if (count(value.stepsWithReads) > count(value.steps)) refuse();
}
/** Copy only inert public result data. Never follows a source recording or invokes accessors. */
function copy(input: unknown): unknown {
  const active = new Set<object>(); let remaining = 64000, bytes = 0;
  function visit(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 16) refuse();
    if (typeof value === 'string') { bytes += value.length * 3; if (bytes > RECORDED_QUERY_LIMITS.maxOutputBytes * 3) refuse(); return value; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (!value || typeof value !== 'object' || active.has(value) || Object.getOwnPropertySymbols(value).length) refuse();
    active.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (value.length > 60000) refuse(); const entries: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, String(index)); if (!field || !('value' in field)) refuse();
        entries.push(visit(field.value, depth + 1));
      }
      if (Object.keys(value).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) refuse();
      result = entries;
    } else {
      const proto = Object.getPrototypeOf(value); if (proto !== null && proto !== Object.prototype) refuse();
      const entries: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!field.enumerable || !('value' in field) || ['__proto__', 'constructor', 'prototype'].includes(key)) refuse();
        bytes += key.length * 3; entries[key] = visit(field.value, depth + 1);
      }
      result = entries;
    }
    active.delete(value); return Object.freeze(result);
  }
  return visit(input, 0);
}

/** Admit the value-free wire result, not source authenticity, authorization or semantic causality. */
export function readRecordedDependencyResult(input: unknown): RecordedDependencyResult {
  try {
    const value = object(copy(input), ['version', 'kind', 'runId', 'key', 'status', 'provenance', 'coverage', 'dependencies', 'order', 'summary', 'limitations', 'error']);
    if (value.version !== 1 || value.kind !== 'recorded-dependencies') refuse();
    if (value.runId !== null) text(value.runId, 256); text(value.key);
    const status = choice(value.status, ['available', 'missing', 'unavailable']);
    const provenance = object(value.provenance, ['requested', 'recorded', 'withReadPrefix', 'withoutReadPrefix']);
    if (provenance.requested !== 'per-write') refuse(); choice(provenance.recorded, ['reads-prefix', 'off', 'unknown']);
    if (count(provenance.withReadPrefix) + count(provenance.withoutReadPrefix) > 60000) refuse();
    if (value.coverage !== undefined) coverage(value.coverage);
    const summary = object(value.summary, ['nodes', 'dataEdges', 'controlEdges', 'partialWriteEdges', 'possibleSourceEdges']);
    count(summary.nodes, RECORDED_QUERY_LIMITS.maxNodes);
    for (const key of ['dataEdges', 'controlEdges', 'partialWriteEdges', 'possibleSourceEdges']) count(summary[key], RECORDED_QUERY_LIMITS.maxEdges);
    for (const limitation of array(value.limitations, 16)) text(limitation, 4096);
    const order = array(value.order, RECORDED_QUERY_LIMITS.maxNodes);
    if (status === 'unavailable') {
      choice(value.error, ['invalid-recording', 'query-limit']);
      if (value.dependencies !== undefined || value.coverage !== undefined || order.length || Object.values(summary).some(number => number !== 0)) refuse();
    } else {
      if (value.error !== undefined) refuse();
      const slice = object(value.dependencies, ['key', 'before', 'missing', 'keysReadKind', 'readsCoverage', 'writerId', 'nodes', 'edges', 'truncated', 'notes']);
      if (slice.key !== value.key) refuse(); text(slice.keysReadKind);
      if (slice.before !== undefined) count(slice.before, 10000);
      if (slice.readsCoverage !== undefined) coverage(slice.readsCoverage);
      const nodes = slice.nodes === undefined ? {} : object(slice.nodes), ids = Object.keys(nodes);
      if (ids.length > RECORDED_QUERY_LIMITS.maxNodes || ids.length !== summary.nodes) refuse();
      for (const id of ids) {
        text(id); const node = object(nodes[id], ['stageId', 'stageName', 'keysWritten', 'depth', 'incompleteSources', 'preRunReads', 'preRunBase', 'preRunView']);
        text(node.stageId); text(node.stageName); texts(node.keysWritten); count(node.depth, RECORDED_QUERY_LIMITS.maxDepth);
        if (node.incompleteSources !== undefined) for (const code of array(node.incompleteSources, 3)) choice(code, ['args', 'env', 'silent']);
        for (const [field, code] of [['preRunReads', 'pre-run-origin'], ['preRunBase', 'from-initial-state'], ['preRunView', 'pre-run-view']] as const) {
          if (node[field] === undefined) continue;
          const note = object(node[field], ['code', 'keys']); if (note.code !== code) refuse(); texts(note.keys);
        }
      }
      const edges = slice.edges === undefined ? [] : array(slice.edges, RECORDED_QUERY_LIMITS.maxEdges);
      let data = 0, control = 0, partial = 0, possible = 0;
      for (const item of edges) {
        const edge = object(item, ['from', 'to', 'kind', 'key', 'weight', 'basis', 'overlap', 'builtOn']);
        if (!Object.hasOwn(nodes, text(edge.from)) || !Object.hasOwn(nodes, text(edge.to))) refuse();
        const kind = choice(edge.kind, ['data', 'control']); if (kind === 'data') data++; else control++;
        if (edge.key !== undefined) text(edge.key);
        if (typeof edge.weight !== 'number' || !Number.isFinite(edge.weight)) refuse();
        if (edge.basis !== undefined) choice(edge.basis, ['nested-rows']);
        if (edge.overlap !== undefined) { choice(edge.overlap, ['replaced-while-running', 'written-while-running', 'view-not-placed']); possible++; }
        if (edge.builtOn !== undefined) { choice(edge.builtOn, ['partial-write', 'built-on-view']); partial++; }
      }
      if (data !== summary.dataEdges || control !== summary.controlEdges || partial !== summary.partialWriteEdges || possible !== summary.possibleSourceEdges) refuse();
      if (slice.truncated !== undefined) {
        const cut = object(slice.truncated, ['byDepth', 'byNodes']); if (typeof cut.byDepth !== 'boolean' || typeof cut.byNodes !== 'boolean') refuse();
      }
      if (slice.notes !== undefined) for (const item of array(slice.notes, 32)) {
        const note = object(item, ['code', 'detail']);
        if (!Object.hasOwn(HONESTY_CODES, text(note.code))) refuse(); text(note.detail, 8192);
      }
      if (status === 'missing') {
        choice(slice.missing, ['empty-log', 'never-written']); if (ids.length || edges.length || slice.writerId !== undefined) refuse();
      } else if (slice.missing !== undefined || !Object.hasOwn(nodes, text(slice.writerId))) refuse();
      const ordered = new Set<string>(); let previous = -1;
      for (const item of order) {
        const row = object(item, ['nodeId', 'commitIndex']), id = text(row.nodeId), position = count(row.commitIndex, 9999);
        if (!Object.hasOwn(nodes, id) || ordered.has(id) || position <= previous) refuse(); ordered.add(id); previous = position;
      }
      if (ordered.size !== ids.length) refuse();
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > RECORDED_QUERY_LIMITS.maxOutputBytes) refuse();
    return value as unknown as RecordedDependencyResult;
  } catch { return refuse(); }
}

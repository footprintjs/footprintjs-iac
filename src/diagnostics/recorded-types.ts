import type { ControlDependency, ReadsCoverage, SliceJSON } from 'foottrace';

/** One admitted native recording scope. No state, secret backend, provider or child-log access is required. */
export interface RecordedDependencyInput {
  snapshot: {
    runId?: string;
    commitLog: readonly unknown[];
    executionTree: unknown;
    writeProvenance?: unknown;
  };
  controlDeps?: Readonly<Record<string, ControlDependency>>;
}
export interface RecordedDependencyOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxEdges?: number;
  maxOutputBytes?: number;
}
export interface RecordedDependencySummary {
  nodes: number;
  dataEdges: number;
  controlEdges: number;
  partialWriteEdges: number;
  possibleSourceEdges: number;
}
export interface RecordedDependencyProvenance {
  requested: 'per-write';
  recorded: 'reads-prefix' | 'off' | 'unknown';
  withReadPrefix: number;
  withoutReadPrefix: number;
}
/** A bounded value-free answer. Flat native node IDs preserve sharing, cycles and edge uncertainty. */
export interface RecordedDependencyResult {
  version: 1;
  kind: 'recorded-dependencies';
  runId: string | null;
  key: string;
  status: 'available' | 'missing' | 'unavailable';
  provenance: RecordedDependencyProvenance;
  coverage?: ReadsCoverage;
  dependencies?: SliceJSON;
  /** First actual commit of each selected node, in this input log's array order; not execution start order. */
  order: readonly { nodeId: string; commitIndex: number }[];
  summary: RecordedDependencySummary;
  limitations: readonly string[];
  error?: 'invalid-recording' | 'query-limit';
}

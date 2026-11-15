import { RecordedQueryError } from './recorded-admission.ts';
import { inspectRecordedDependencies, unavailableRecordedDependencies } from './recorded-slice.ts';
import { readRecordedDependencyResult } from './recorded-result.ts';
import type { RecordedDependencyInput, RecordedDependencyOptions, RecordedDependencyResult } from './recorded-types.ts';
export type * from './recorded-types.ts';
export { RECORDED_QUERY_LIMITS } from './recorded-admission.ts';
export { readRecordedDependencyResult } from './recorded-result.ts';

/** Browser-safe, read-only native query. It never resolves credentials, opens storage or calls a provider. */
export function queryRecordedDependencies(input: RecordedDependencyInput, key: string,
  options?: RecordedDependencyOptions): RecordedDependencyResult {
  try { return readRecordedDependencyResult(inspectRecordedDependencies(input, key, options).result); }
  catch (error) { return unavailableRecordedDependencies(key, error instanceof RecordedQueryError ? error.code : 'invalid-recording'); }
}

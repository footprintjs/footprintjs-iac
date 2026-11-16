import { type ScopeFactory } from 'footprintjs/advanced';
import { AdapterFlowScope } from '../adapter-flow/scope.ts';
import type { ExecutionFailure, OperationResult } from './types.ts';

/** Narrow native scope adapter: every value crosses FootPrint's recording funnel. */
export class ExecutionScope extends AdapterFlowScope {
  get nativeNeedsEffect(): boolean { return this.getValue('nativeNeedsEffect') as boolean; }
  get nativeRetry(): boolean { return this.getValue('nativeRetry') as boolean; }
  get nativeHasError(): boolean { return this.getValue('nativeHasError') as boolean; }
  get failed(): boolean { return this.getValue('failed') as boolean; }
  get failure(): ExecutionFailure | null { return this.getValue('failure') as ExecutionFailure | null; }

  /**
   * Siblings own disjoint root result keys, so joining reads each actual writer.
   * Native setGlobal is marked internal in footprintjs 11.1.0. Keep this use
   * isolated and exactly pinned; upgrades must pass replay/provenance tests.
   * No child writes shared failure flags: only the settled root join does so.
   */
  publishResult(resourceId: string, result: OperationResult): void {
    this.setGlobal(`result:${resourceId}`, result);
  }

  publishProgress(resourceId: string, value: unknown): void {
    this.setGlobal(`progress:${resourceId}`, value);
  }
}

export type ExecutionStage = (scope: ExecutionScope) => Promise<void> | void;
export const executionScopeFactory: ScopeFactory<ExecutionScope> = (context, name, readOnly, environment) =>
  new ExecutionScope(context, name, readOnly, environment);

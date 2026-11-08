import type { Action, PlannedOperation } from '../types.ts';

export interface ExecutionFailure { resourceId: string; message: string }
export type FlowState = Record<string, unknown> & { failed: boolean; failure: ExecutionFailure | null };
export type OperationResult =
  | { status: 'complete'; action: Action; attempts: number; physicalId?: string | null; reconciled?: boolean }
  | { status: 'failed'; message: string }
  | { status: 'skipped'; reason?: ExecutionFailure | null };
export type OperationExecutor = (operation: PlannedOperation) => Promise<OperationResult>;
export interface OperationBatch { index: number; operations: PlannedOperation[] }

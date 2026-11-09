import { DEPLOYMENT_EVENT, type DeploymentStatus } from '../progress/types.ts';
import type { PlannedOperation } from '../types.ts';
import type { ExecutionScope } from './scope.ts';

/** Scope writes remain replayable; the native event supplies the live projection. */
export function recordProgress(scope: ExecutionScope, runId: string, operation: PlannedOperation, status: DeploymentStatus, message?: string): void {
  const payload = {
    version: 1 as const, runId, resourceId: operation.resource.id, status, action: operation.action,
    ...(message === undefined ? {} : { message }),
  };
  scope.publishProgress(operation.resource.id, payload);
  scope.emitEvent(DEPLOYMENT_EVENT, payload);
}

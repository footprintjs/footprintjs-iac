import { canonical } from '../util.ts';
import type { Action } from '../types.ts';
import type { DeploymentStatus } from './types.ts';
export function progressAdmission(condition: unknown): asserts condition { if (!condition) throw Error('native-progress-not-admitted'); }
export interface ProgressPayload { version: 1; runId: string; resourceId: string; status: DeploymentStatus; action: Action; message?: string }
export function progressPayload(value: unknown, runId: string, ids: ReadonlySet<string>): value is ProgressPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1 && row.runId === runId && typeof row.resourceId === 'string' && ids.has(row.resourceId)
    && ['pending', 'deploying', 'ready', 'failed', 'skipped', 'deleted'].includes(String(row.status))
    && ['create', 'update', 'verify', 'delete', 'noop'].includes(String(row.action))
    && (row.message === undefined || typeof row.message === 'string')
    && Object.keys(row).every(key => ['version', 'runId', 'resourceId', 'status', 'action', 'message'].includes(key));
}
export const progressCore = (event: ProgressPayload) => ({ version: event.version, runId: event.runId, resourceId: event.resourceId, status: event.status, action: event.action });
export const progressBindingKey = (runtimeStageId: string, resourceId: string) => canonical([runtimeStageId, resourceId]);

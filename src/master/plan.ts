import { array, identifier, jsonCopy, keys, object, text } from '../graph/data.ts';
import { readResource } from '../graph/resources.ts';
import type { Plan } from '../types.ts';
import { fingerprint } from '../util.ts';
import { digestValue } from './revision.ts';
import { hasResourceAttributes, validateInputResolution } from '../resource-attributes.ts';

/** Capture exactly the reviewed operations and observations; apply recomputes this under its state lock. */
export function readReviewedPlan(input: unknown): Plan {
  const row = object(jsonCopy(input), 'reviewed plan');
  keys(row, ['stack', 'operations', 'retained'], 'reviewed plan'); identifier(row.stack, 'reviewed plan stack');
  const ids = new Set<string>();
  for (const value of array(row.operations, 'reviewed operations')) {
    const operation = object(value, 'reviewed operation');
    keys(operation, ['resource', 'action', 'desiredFingerprint', 'observed', 'operationId', 'inputResolution'], 'reviewed operation');
    const resource = readResource(operation.resource!);
    if (ids.has(resource.id)) throw Error('Duplicate reviewed operation'); ids.add(resource.id);
    if (!['create', 'update', 'verify', 'noop', 'delete'].includes(String(operation.action))) throw Error('Invalid reviewed action');
    digestValue(operation.desiredFingerprint, 'reviewed desired fingerprint'); digestValue(operation.operationId, 'reviewed operation ID');
    if (operation.desiredFingerprint !== fingerprint(resource.spec)) throw Error('Reviewed desired fingerprint mismatch');
    if (operation.action !== 'delete' && hasResourceAttributes(resource) !== (operation.inputResolution !== undefined)) {
      throw Error('Reviewed provider inputs do not match resource references');
    }
    if (operation.inputResolution !== undefined) validateInputResolution(operation.inputResolution, operation.action);
    const observed = object(operation.observed!, 'reviewed observation');
    keys(observed, ['exists', 'fingerprint', 'physicalId', 'owned', 'ready', 'attributes'], 'reviewed observation');
    if (typeof observed.exists !== 'boolean' || (observed.owned !== undefined && typeof observed.owned !== 'boolean')
      || (observed.ready !== undefined && typeof observed.ready !== 'boolean')) throw Error('Invalid reviewed observation');
    if (observed.fingerprint !== undefined) text(observed.fingerprint, 'observed fingerprint');
    if (observed.attributes !== undefined) {
      if (observed.exists !== true) throw Error('Missing resources cannot publish provider attributes');
      object(observed.attributes, 'reviewed observation attributes');
    }
    if (observed.physicalId !== undefined && (!text(observed.physicalId, 'observed identity') || String(observed.physicalId).length > 4096)) throw Error('Invalid observed identity');
  }
  if (row.retained !== undefined) for (const value of array(row.retained, 'retained resources')) {
    const retained = object(value, 'retained resource'); keys(retained, ['resourceId', 'reason'], 'retained resource');
    identifier(retained.resourceId, 'retained resource');
    if (!['retention-policy', 'dependency'].includes(String(retained.reason))) throw Error('Invalid retention reason');
  }
  return row as unknown as Plan;
}
export function fingerprintPlan(plan: Plan): string { return fingerprint(readReviewedPlan(plan)); }

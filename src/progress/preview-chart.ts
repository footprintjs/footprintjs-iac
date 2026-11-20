import { createApplyChart } from '../execution/create-apply-chart.ts';
import { concurrencyLimit } from '../execution/schedule.ts';
import { array, identifier, jsonCopy, keys, object, text } from '../graph/data.ts';
import type { Plan } from '../types.ts';
import { validateInputResolution } from '../resource-attributes.ts';
import { readDeploymentSchedulePreview, type DeploymentSchedulePreview } from './preview.ts';

/** Node-side construction of the same native topology as apply, without executing a stage or
 * contacting a provider. The separately supplied plan is advisory; apply still replans its actual run.
 */
export function previewDeploymentChart(plan: Plan, options: { maxConcurrency?: number; graphDigest?: string } = {}): DeploymentSchedulePreview {
  const detached = readPreviewPlan(plan);
  const settings = object(jsonCopy(options), 'deployment preview options');
  keys(settings, ['maxConcurrency', 'graphDigest'], 'deployment preview options');
  const limit = concurrencyLimit(settings.maxConcurrency as number | undefined);
  const built = createApplyChart(detached, async () => { throw Error('A deployment preview cannot execute'); }, {}, limit, 'schedule-preview');
  return readDeploymentSchedulePreview({ version: 1, kind: 'deployment-schedule-preview', stack: detached.stack,
    ...(settings.graphDigest === undefined ? {} : { graphDigest: settings.graphDigest }),
    structure: built.chart.buildTimeStructure, resources: built.resources.map(({ schedule: _schedule, ...resource }) => resource) });
}

function readPreviewPlan(input: unknown): Plan {
  const row = object(jsonCopy(input), 'deployment preview plan');
  keys(row, ['stack', 'operations', 'retained'], 'deployment preview plan');
  identifier(row.stack, 'preview stack');
  const ids = new Set<string>();
  for (const item of array(row.operations, 'preview operations')) {
    const operation = object(item, 'preview operation');
    keys(operation, ['resource', 'action', 'desiredFingerprint', 'observed', 'operationId', 'inputResolution'], 'preview operation');
    const resource = object(operation.resource!, 'preview resource');
    keys(resource, ['id', 'provider', 'spec', 'dependsOn', 'lifecycle'], 'preview resource');
    const id = identifier(resource.id, 'preview resource ID');
    if (ids.has(id)) throw Error('Duplicate preview resource ID'); ids.add(id);
    if (!text(resource.provider, 'preview provider')) throw Error('Invalid preview provider');
    object(resource.spec!, 'preview resource spec');
    if (resource.dependsOn !== undefined) for (const dependency of array(resource.dependsOn, 'preview dependencies')) identifier(dependency, 'preview dependency');
    if (!['create', 'update', 'verify', 'delete', 'noop'].includes(String(operation.action))) throw Error('Invalid preview action');
    if (operation.inputResolution !== undefined) validateInputResolution(operation.inputResolution, operation.action);
  }
  return row as unknown as Plan;
}

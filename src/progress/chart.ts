import type { FlowChart } from 'footprintjs';
import { array, jsonCopy, keys, object, text } from '../graph/data.ts';
import type { Action } from '../types.ts';
import { readScheduleReasons, type ScheduleReasons } from './schedule-reasons.ts';
export type { ScheduleReasons } from './schedule-reasons.ts';

/** Explicit bindings emitted by the one native apply-chart construction root. */
export interface DeploymentResourceStages {
  readonly resourceId: string; readonly action: Action; readonly batchIndex: number;
  readonly executeStageId: string; readonly skipStageId: string; readonly gateStageId: string; readonly joinStageId?: string;
  readonly schedule?: ScheduleReasons;
}
export type NativeDeploymentStructure = FlowChart<void, unknown>['buildTimeStructure'];
export interface DeploymentChart {
  readonly version: 1; readonly runId: string; readonly stack: string; readonly graphDigest?: string;
  readonly structure: NativeDeploymentStructure; readonly resources: readonly DeploymentResourceStages[];
}
/** IaC's explicit observer bridge; this is not a FootPrint CombinedRecorder hook. */
export interface NativeDeploymentRecording {
  readonly snapshot: Record<string, unknown>; readonly structure: NativeDeploymentStructure;
  readonly provenance: { readonly runId: string; readonly stack: string; readonly graphDigest?: string };
}
export interface DeploymentChartObserver {
  readonly id: string; onChart(chart: DeploymentChart): void;
  /** Bounded metadata from actual native hooks/snapshots; partial observations never authorize deployment. */
  onRecording?(recording: NativeDeploymentRecording): void;
}

const actions = new Set<Action>(['create', 'update', 'verify', 'delete', 'noop']);
const stageTypes = new Set(['stage', 'decider', 'selector', 'fork', 'streaming', 'subflow', 'loop']);

/** Admit detached native topology without invoking accessors or accepting executable metadata. */
export function readDeploymentChart(input: unknown): DeploymentChart {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('Invalid deployment chart');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !['version', 'runId', 'stack', 'graphDigest', 'structure', 'resources'].includes(key)
      || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable) throw Error('Invalid deployment chart property');
  }
  const value = (key: string) => descriptors[key]?.value;
  if (value('version') !== 1) throw Error('Unsupported deployment chart version');
  const runId = nonempty(value('runId'), 'run ID'), stack = nonempty(value('stack'), 'stack');
  const graphDigest = value('graphDigest');
  if (graphDigest !== undefined && (typeof graphDigest !== 'string' || !/^[a-f0-9]{64}$/.test(graphDigest))) throw Error('Invalid deployment chart graph digest');
  const structure = copyStructure(value('structure'));
  // Stage IDs are local to a native chart. A loop reference names an existing
  // stage; a mounted subflow owns a fresh namespace (including repeated mounts).
  const stageIds = new Set<string>(), pending = [{node:structure,ids:stageIds}], references:{id:string;ids:Set<string>}[]=[];
  while (pending.length) {
    const {node,ids:localIds} = pending.pop()!;
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.id !== 'string' || !node.id
      || typeof node.name !== 'string' || !stageTypes.has(node.type)) throw Error('Invalid native deployment stage');
    if(node.isLoopReference){references.push({id:node.id,ids:localIds});continue;}
    if (localIds.has(node.id)) throw Error('Duplicate native deployment stage ID');
    localIds.add(node.id);
    if (node.next !== undefined) pending.push({node:node.next,ids:localIds});
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw Error('Invalid native deployment children');
      pending.push(...node.children.map(node=>({node,ids:localIds})));
    }
    if (node.subflowStructure !== undefined) pending.push({node:node.subflowStructure,ids:new Set<string>()});
  }
  if(references.some(reference=>!reference.ids.has(reference.id)))throw Error('Native deployment loop refers to an absent stage');
  const ids = new Set<string>();
  const resources = array(jsonCopy(value('resources')), 'deployment resource-stage mappings').map(item => {
    const row = object(item, 'deployment resource stages');
    keys(row, ['resourceId', 'action', 'batchIndex', 'executeStageId', 'skipStageId', 'gateStageId', 'joinStageId', 'schedule'], 'deployment resource stages');
    const resourceId = nonempty(row.resourceId, 'resource ID');
    if (ids.has(resourceId)) throw Error('Duplicate deployment resource-stage mapping'); ids.add(resourceId);
    if (!actions.has(row.action as Action) || !Number.isSafeInteger(row.batchIndex) || (row.batchIndex as number) < 0) throw Error('Invalid deployment resource operation');
    const stageId = (key: string) => {
      const id = nonempty(row[key], 'stage ID');
      if (!stageIds.has(id)) throw Error('Deployment resource mapping refers to an absent native stage');
      return id;
    };
    return Object.freeze({ resourceId, action: row.action as Action, batchIndex: row.batchIndex as number,
      executeStageId: stageId('executeStageId'), skipStageId: stageId('skipStageId'), gateStageId: stageId('gateStageId'),
      ...(row.joinStageId !== undefined && { joinStageId: stageId('joinStageId') }),
      ...(row.schedule !== undefined && { schedule: readScheduleReasons(row.schedule, row.batchIndex as number) }) });
  });
  return Object.freeze({ version: 1, runId, stack, ...(graphDigest === undefined ? {} : { graphDigest }),
    structure, resources: Object.freeze(resources) });
}

function nonempty(value: unknown, field: string): string {
  const result = text(value, 'deployment chart ' + field);
  if (!result) throw Error('Invalid deployment chart ' + field);
  return result;
}

/** Native charts can be long next-chains; audit and freeze iteratively instead of using graph JSON's depth limit. */
function copyStructure(input: unknown): NativeDeploymentStructure {
  const active = new Set<object>();
  const tasks: { value: unknown; depth: number; exit?: boolean }[] = [{ value: input, depth: 0 }];
  let remaining = 500_000;
  while (tasks.length) {
    const task = tasks.pop()!, value = task.value;
    if (task.exit) { active.delete(value as object); continue; }
    if (--remaining < 0 || task.depth > 20_000) throw Error('Native chart exceeds capture bounds');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) continue;
    if (!value || typeof value !== 'object' || active.has(value)) throw Error('Native chart must be finite acyclic JSON');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Native chart requires plain JSON');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) throw Error('Native chart cannot contain symbols');
    active.add(value); tasks.push({ ...task, exit: true });
    if (Array.isArray(value)) {
      if (value.length > 100_000 || Object.keys(descriptors).length !== value.length + 1
        || Object.keys(descriptors).some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw Error('Native chart arrays must be dense');
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable) throw Error('Native chart cannot contain accessors or hidden fields');
      tasks.push({ value: descriptor.value, depth: task.depth + 1 });
    }
  }
  const copied = structuredClone(input) as NativeDeploymentStructure;
  const objects: object[] = [copied];
  while (objects.length) {
    const value = objects.pop()!;
    for (const child of Object.values(value)) if (child && typeof child === 'object') objects.push(child);
    Object.freeze(value);
  }
  return copied;
}

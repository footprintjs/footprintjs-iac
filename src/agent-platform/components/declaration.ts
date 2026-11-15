import type { InfraGraph } from '../../graph/types.ts';
import { freeze, identifier } from '../../graph/data.ts';
import { fingerprint } from '../../util.ts';
import { digest, label, readAgentDeployment, row } from '../data.ts';
import type { AgentDeployment } from '../types.ts';
import type { AgentComponent, AgentComponentGraph, AgentComponentGraphInput, AgentComponentRelation, AgentRuntimeBoundary } from './types.ts';

function refuse(): never { throw Error('Unsupported agent component graph or binding'); }
function ids(input: unknown, max: number, empty = false): string[] {
 if (!Array.isArray(input) || input.length > max || !empty && input.length === 0) refuse();
 const values = input.map(value => identifier(value, 'agent component')); if (new Set(values).size !== values.length) refuse(); return values;
}
function array(input: unknown, max: number): unknown[] { if (!Array.isArray(input) || input.length > max) refuse(); return input; }
function component(input: unknown, deployment: AgentDeployment): AgentComponent {
 const value = row(input, ['id', 'label', 'kind', 'roles', 'mode', 'resourceIds', 'environmentResourceId', 'requiredCheckIds', 'required', 'selected', 'boundaryId', 'storage', 'sharing', 'physicalGroupId']);
 const resourceIds = ids(value.resourceIds, 256), environmentResourceId = identifier(value.environmentResourceId, 'component environment');
 if (!['execution', 'store', 'context', 'connection'].includes(String(value.kind)) || !['create', 'existing'].includes(String(value.mode))
  || typeof value.required !== 'boolean' || value.selected !== undefined && typeof value.selected !== 'boolean'
  || resourceIds.some(id => !deployment.resourceIds.includes(id)) || !resourceIds.includes(environmentResourceId)
  || value.storage !== undefined && !['memory', 'persistent'].includes(String(value.storage))
  || value.sharing !== undefined && !['shared', 'dedicated'].includes(String(value.sharing))
  || value.storage !== undefined && value.kind !== 'store') refuse();
 return { id: identifier(value.id, 'component'), label: label(value.label), kind: value.kind as AgentComponent['kind'], roles: ids(value.roles, 32),
  mode: value.mode as AgentComponent['mode'], resourceIds, environmentResourceId, requiredCheckIds: ids(value.requiredCheckIds, 64), required: value.required,
  ...(value.selected === undefined ? {} : { selected: value.selected }), ...(value.boundaryId === undefined ? {} : { boundaryId: identifier(value.boundaryId, 'component boundary') }),
  ...(value.storage === undefined ? {} : { storage: value.storage as AgentComponent['storage'] }), ...(value.sharing === undefined ? {} : { sharing: value.sharing as AgentComponent['sharing'] }),
  ...(value.physicalGroupId === undefined ? {} : { physicalGroupId: identifier(value.physicalGroupId, 'physical state group') }) };
}
function boundary(input: unknown): AgentRuntimeBoundary {
 const value = row(input, ['id', 'label', 'kind', 'parentId', 'strategy', 'realizedBy', 'requiredCheckIds']);
 if (!['platform', 'host', 'namespace', 'pod', 'container', 'service', 'shared', 'isolation'].includes(String(value.kind))) refuse();
 const strategy = value.strategy === undefined ? undefined : row(value.strategy, ['id', 'label']);
 if ((strategy || value.realizedBy !== undefined) && (!value.realizedBy || !Array.isArray(value.requiredCheckIds) || !value.requiredCheckIds.length)) refuse();
 return { id: identifier(value.id, 'runtime boundary'), label: label(value.label), kind: value.kind as AgentRuntimeBoundary['kind'],
  ...(value.parentId === undefined ? {} : { parentId: identifier(value.parentId, 'parent boundary') }),
  ...(strategy ? { strategy: { id: identifier(strategy.id, 'runtime strategy'), label: label(strategy.label) } } : {}),
  ...(value.realizedBy === undefined ? {} : { realizedBy: identifier(value.realizedBy, 'realization component') }),
  ...(value.requiredCheckIds === undefined ? {} : { requiredCheckIds: ids(value.requiredCheckIds, 64) }) };
}
function relation(input: unknown): AgentComponentRelation {
 const value = row(input, ['id', 'from', 'to', 'kind', 'required', 'checkComponentId']);
 if (!['order', 'communicatesWith', 'supports', 'contains'].includes(String(value.kind)) || value.required !== undefined && typeof value.required !== 'boolean') refuse();
 return { id: identifier(value.id, 'component relation'), from: identifier(value.from, 'relation source'), to: identifier(value.to, 'relation target'),
  kind: value.kind as AgentComponentRelation['kind'], ...(value.required === undefined ? {} : { required: value.required }),
  ...(value.checkComponentId === undefined ? {} : { checkComponentId: identifier(value.checkComponentId, 'connection check component') }) };
}
function unique(values: readonly { id: string }[]): void { if (new Set(values.map(value => value.id)).size !== values.length) refuse(); }
function body(input: unknown, deployment: AgentDeployment) {
 const value = row(input, ['id', 'label', 'components', 'boundaries', 'relations']);
 const components = array(value.components, 128).map(item => component(item, deployment)), boundaries = array(value.boundaries, 128).map(boundary), relations = array(value.relations, 1024).map(relation);
 if (!components.length || !components.some(value => value.required && value.selected !== false)) refuse(); unique(components); unique(boundaries); unique(relations); unique([...components, ...boundaries]);
 const physicalStores = components.filter(value => value.kind === 'store' && value.physicalGroupId).map(value => value.physicalGroupId);
 if (new Set(physicalStores).size !== physicalStores.length) refuse();
 const componentIds = new Set(components.map(value => value.id)), boundaryIds = new Set(boundaries.map(value => value.id)), all = new Set([...componentIds, ...boundaryIds]);
 for (const item of components) if (item.boundaryId && !boundaryIds.has(item.boundaryId)) refuse();
 for (const item of boundaries) {
  if (item.parentId && !boundaryIds.has(item.parentId)) refuse();
  if (item.realizedBy) {
   const anchor = components.find(value => value.id === item.realizedBy);
   if (!anchor || item.requiredCheckIds?.some(id => !anchor.requiredCheckIds.includes(id))) refuse();
  }
  const seen = new Set([item.id]); let cursor = item.parentId;
  while (cursor) { if (seen.has(cursor)) refuse(); seen.add(cursor); cursor = boundaries.find(value => value.id === cursor)?.parentId; }
 }
 for (const item of relations) {
  if (!all.has(item.from) || !all.has(item.to) || item.from === item.to) refuse();
  if (item.kind === 'order' && (!componentIds.has(item.from) || !componentIds.has(item.to))) refuse();
  if (item.kind === 'contains' && (!boundaryIds.has(item.from) || !(components.some(value => value.id === item.to && value.boundaryId === item.from)
   || boundaries.some(value => value.id === item.to && value.parentId === item.from)))) refuse();
  if (item.checkComponentId && !components.some(value => value.id === item.checkComponentId && value.kind === 'connection')) refuse();
  if (item.kind === 'communicatesWith' && item.required === true && (!item.checkComponentId || !components.some(value => value.id === item.checkComponentId && value.required && value.selected !== false))) refuse();
 }
 const result = { version: 1 as const, kind: 'agent-component-graph' as const, id: identifier(value.id, 'agent component graph'), label: label(value.label),
  deploymentDigest: deployment.digest, revisionDigest: deployment.revision.digest, graphDigest: deployment.graphDigest, target: deployment.target, components, boundaries, relations };
 componentBatches(result, 16); return result;
}
/** Pure DAG compilation; actual sequencing/forks are executed by the native chart. */
export function componentBatches(definition: Pick<AgentComponentGraph, 'components' | 'relations'>, maxConcurrency: number): string[][] {
 if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) refuse();
 const remaining = new Set(definition.components.map(value => value.id)), complete = new Set<string>(), batches: string[][] = [];
 while (remaining.size) {
  const ready = [...remaining].filter(id => definition.relations.filter(value => value.kind === 'order' && value.to === id).every(value => complete.has(value.from)));
  if (!ready.length) refuse();
  for (let offset = 0; offset < ready.length; offset += maxConcurrency) batches.push(ready.slice(offset, offset + maxConcurrency));
  for (const id of ready) { remaining.delete(id); complete.add(id); }
 }
 return batches;
}
export function defineAgentComponentGraph(input: AgentComponentGraphInput, inputDeployment: AgentDeployment, graph: InfraGraph): AgentComponentGraph {
 const deployment = readAgentDeployment(inputDeployment, graph), value = body(input, deployment); return freeze({ ...value, digest: fingerprint(value) });
}
export function readAgentComponentGraph(input: unknown, deployment: AgentDeployment, graph: InfraGraph): AgentComponentGraph {
 const value = row(input, ['version', 'kind', 'id', 'label', 'deploymentDigest', 'revisionDigest', 'graphDigest', 'target', 'components', 'boundaries', 'relations', 'digest']);
 if (value.version !== 1 || value.kind !== 'agent-component-graph') refuse();
 const definition = defineAgentComponentGraph({ id: value.id as string, label: value.label as string, components: value.components as AgentComponent[], boundaries: value.boundaries as AgentRuntimeBoundary[], relations: value.relations as AgentComponentRelation[] }, deployment, graph);
 if (definition.digest !== digest(value.digest) || value.deploymentDigest !== definition.deploymentDigest || value.revisionDigest !== definition.revisionDigest || value.graphDigest !== definition.graphDigest || fingerprint(value.target) !== fingerprint(definition.target)) refuse();
 return definition;
}

import { freeze } from '../../graph/data.ts';
import type { AgentComponentGraph, AgentComponentsState, AgentComponentState, AgentBoundaryProgress, AgentComponentStatus, AgentComponentProjection, AgentRuntimeBoundary } from './types.ts';

export function componentProgress(component: AgentComponentState | undefined): AgentBoundaryProgress {
 const stages = component?.readiness?.flow.stages ?? [];
 return { completed: stages.filter(stage => stage.status === 'passed').length, total: 4,
  indeterminate: component?.status === 'incomplete', unit: 'stages' };
}
function boundaryObservation(boundary: AgentRuntimeBoundary, components: readonly AgentComponentState[]) {
 const anchor = components.find(value => value.id === boundary.realizedBy), segment = anchor?.readiness?.flow.segments.at(-1), resource = anchor?.readiness?.flow.resource;
 const observed = !!anchor && ['ready', 'failed', 'paused'].includes(anchor.status) && !!resource && !!segment && ['passed', 'failed', 'paused'].includes(segment.status)
  && (boundary.kind !== 'isolation' || !!anchor.readiness?.capabilities.some(value => value.id === 'conversationIsolation' && value.status === 'supported' && value.proof))
  && !!boundary.requiredCheckIds?.length && boundary.requiredCheckIds.every(id => anchor.readiness?.flow.verification?.checks.some(check => check.id === id && check.passed));
 return { observed, anchor, segment, resource };
}
export function componentOutcome(components: readonly AgentComponentState[], definition: AgentComponentGraph): AgentComponentsState['status'] {
 if (components.some(value => value.status === 'incomplete')) return 'incomplete';
 if (components.some(value => value.status === 'paused')) return 'paused';
 const required = definition.components.filter(value => value.required && value.selected !== false);
 if (required.length && required.every(value => components.some(state => state.id === value.id && state.status === 'ready'))) {
  for (const component of required) {
   let id = component.boundaryId;
   while (id) {
    const boundary = definition.boundaries.find(value => value.id === id)!;
    if (!boundaryObservation(boundary, components).observed) return 'failed';
    id = boundary.parentId;
   }
  }
  return 'ready';
 }
 return components.some(value => value.status === 'failed') ? 'failed' : 'incomplete';
}

function combined(values: readonly AgentComponentState[]): AgentComponentStatus {
 for (const status of ['incomplete', 'failed', 'paused', 'running', 'pending', 'skipped'] as const) if (values.some(value => value.status === status)) return status;
 return values.length && values.every(value => value.status === 'ready') ? 'ready' : 'pending';
}
/** Project only admitted workflow state. Fractions count native stages, never duration. */
export function projectAgentComponents(definition: AgentComponentGraph, state: AgentComponentsState): AgentComponentProjection {
 if (state.definitionDigest !== definition.digest || state.components.length !== definition.components.length
  || new Set(state.components.map(value => value.id)).size !== state.components.length
  || state.components.some(value => !definition.components.some(component => component.id === value.id))) throw Error('Agent component projection binding changed');
 const nodes = definition.components.map(component => {
  const saved = state.components.find(value => value.id === component.id)!;
  return { ...component, ...saved, progress: componentProgress(saved) };
 });
 const boundaries = definition.boundaries.map(boundary => {
  const children = new Set([boundary.id]); let previous = 0;
  while (children.size !== previous) { previous = children.size; for (const value of definition.boundaries) if (value.parentId && children.has(value.parentId)) children.add(value.id); }
  const memberIds = new Set(definition.components.filter(value => value.boundaryId && children.has(value.boundaryId)).map(value => value.id));
  for (const relation of definition.relations) if (relation.kind === 'communicatesWith' && relation.required && relation.checkComponentId
   && (memberIds.has(relation.from) || memberIds.has(relation.to) || children.has(relation.from) || children.has(relation.to))) memberIds.add(relation.checkComponentId);
  if (boundary.realizedBy) memberIds.add(boundary.realizedBy);
  const members = nodes.filter(value => memberIds.has(value.id) && value.required && value.selected !== false);
  const { observed, segment, resource } = boundaryObservation(boundary, nodes);
  const progress = { completed: members.reduce((count, value) => count + value.progress.completed, 0), total: members.length * 4,
   indeterminate: !members.length || members.some(value => value.progress.indeterminate), unit: 'stages' as const };
  let status = combined(members);
  if (status === 'ready' && !observed) status = 'incomplete';
  return { id: boundary.id, status, observed, progress,
   ...(observed ? { physicalResource: { id: resource!.id, kind: resource!.kind, physicalId: resource!.physicalId, scope: resource!.scope },
    recording: { runId: segment!.runId, evidencePath: segment!.evidencePath, tracePath: segment!.tracePath, complete: true as const } } : {}) };
 });
 const relations = definition.relations.map(relation => {
  if (relation.kind !== 'communicatesWith') return relation;
  const check = nodes.find(value => value.id === relation.checkComponentId);
  const status = check?.status === 'ready' ? 'connected' : check?.status === 'failed' ? 'failed' : check?.status === 'running' ? 'checking' : 'untested';
  return { ...relation, status: status as 'untested' | 'checking' | 'connected' | 'failed' };
 });
 return freeze({ definition, state, nodes, boundaries, relations });
}

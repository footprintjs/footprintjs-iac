import { select } from 'footprintjs';
import { componentReference } from './child.ts';
import { componentOutcome } from './projection.ts';
import type { AgentComponentGraph, AgentComponentsState, AgentComponentState } from './types.ts';
import type { AgentComponentsScope } from './scope.ts';

export interface ComponentChartStages {
 definition: AgentComponentGraph; executionId: string; resumedFromRunId?: string; resumeComponentId?: string; state(): AgentComponentsState;
 run(id: string): Promise<AgentComponentState>; update(value: AgentComponentState): void;
}
export const componentStageId = (id: string) => 'component-' + id;
export const skippedStageId = (id: string) => 'blocked-' + id;
export function loadComponentGraphStage(config: ComponentChartStages) { return (scope: AgentComponentsScope) => {
 scope.setValue('resumedFromRunId', config.resumedFromRunId ?? null); scope.setValue('definitionDigest', config.definition.digest); scope.setValue('executionId', config.executionId);
 for (const item of config.definition.components) {
  const saved = config.state().components.find(value => value.id === item.id)!;
  scope.setValue('selected:' + item.id, item.selected !== false);
  scope.setValue('eligible:' + item.id, saved.status !== 'ready' && saved.status !== 'failed' && saved.status !== 'incomplete' && item.selected !== false);
  scope.publishResult(item.id, componentReference(saved));
 }
}; }
export function selectComponentBatch(config: ComponentChartStages, batch: readonly string[]) { return (scope: AgentComponentsScope) => {
 for (const id of batch) {
  const item = config.definition.components.find(value => value.id === id)!, existing = config.state().components.find(value => value.id === id)!;
  const dependencies = config.definition.relations.filter(value => value.kind === 'order' && value.to === id).map(value => scope.getValue('component:' + value.from) as { status?: string });
  const resuming = config.resumeComponentId === id && existing.status === 'paused';
  const unsettled = config.state().components.some(value => value.id !== id && (value.status === 'incomplete'
   || value.status === 'failed' && config.definition.components.find(item => item.id === value.id)?.required
   || value.status === 'paused' && value.id !== config.resumeComponentId && !resuming));
  scope.setValue('eligible:' + id, item.selected !== false && !unsettled && existing.status !== 'ready' && existing.status !== 'failed' && existing.status !== 'incomplete' && (existing.status !== 'paused' || resuming)
   && dependencies.every(value => value?.status === 'ready' || value?.status === 'skipped'));
 }
 return select(scope, batch.flatMap(id => [
  { when: { ['eligible:' + id]: { eq: true } }, then: componentStageId(id), label: 'Selected component and dependencies are ready' },
  { when: { ['eligible:' + id]: { eq: false } }, then: skippedStageId(id), label: 'Retain completed, unselected or blocked component' },
 ]));
}; }
export function runComponentStage(config: ComponentChartStages, id: string) { return async (scope: AgentComponentsScope) => {
 scope.setValue('intent:' + id, { executionId: config.executionId, definitionDigest: config.definition.digest, componentId: id });
 let value: AgentComponentState;
 try { value = await config.run(id); } catch { value = { id, status: 'incomplete' }; }
 config.update(value); scope.publishResult(id, componentReference(value));
}; }
export function retainComponentStage(config: ComponentChartStages, id: string) { return (scope: AgentComponentsScope) => {
 const item = config.definition.components.find(value => value.id === id)!, current = config.state().components.find(value => value.id === id)!;
 const failedDependency = config.definition.relations.filter(value => value.kind === 'order' && value.to === id)
  .some(value => ['failed', 'skipped', 'incomplete'].includes((scope.getValue('component:' + value.from) as { status?: string })?.status ?? ''));
 const value = item.selected === false ? { id, status: 'skipped' as const } : current.status === 'pending' && failedDependency ? { id, status: 'skipped' as const } : current;
 config.update(value); scope.publishResult(id, componentReference(value));
}; }
export function joinComponentBatch(config: ComponentChartStages, ids: readonly string[]) { return (scope: AgentComponentsScope) => {
 for (const id of ids) {
  const recorded = scope.getValue('component:' + id) as { id?: string } | undefined;
  if (!recorded || recorded.id !== id) config.update({ id, status: 'incomplete' });
 }
}; }
export function finishComponentGraphStage(config: ComponentChartStages) { return (scope: AgentComponentsScope) => {
 for (const item of config.definition.components) scope.getValue('component:' + item.id);
 scope.setValue('outcome', componentOutcome(config.state().components, config.definition));
}; }

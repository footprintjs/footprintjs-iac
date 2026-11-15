import { join } from 'node:path';
import type { CombinedRecorder } from 'footprintjs';
import type { InfraGraph } from '../../graph/types.ts';
import { FileResourceFlowStore } from '../../resource-flow/store.ts';
import { defineAgentDeployment } from '../data.ts';
import { AgentReadinessWorkflow } from '../workflow.ts';
import type { AgentDeployment, AgentReadinessState } from '../types.ts';
import { fingerprint } from '../../util.ts';
import type { AgentComponent, AgentComponentGraph, AgentComponentPorts, AgentComponentState } from './types.ts';

export const COMPONENT_BINDING_RECORDER = 'iac-agent-component-binding';
export function componentBinding(definition: AgentComponentGraph, component: AgentComponent) {
 return { componentGraphDigest: definition.digest, deploymentDigest: definition.deploymentDigest, revisionDigest: definition.revisionDigest, component };
}
export function createComponentWorkflow(definition: AgentComponentGraph, component: AgentComponent, deployment: AgentDeployment, graph: InfraGraph, directory: string, ports: AgentComponentPorts): AgentReadinessWorkflow {
 const child = defineAgentDeployment({ id: `${definition.id}.${component.id}`, label: component.label, revision: deployment.revision, target: deployment.target,
  resourceIds: component.resourceIds, environmentResourceId: component.environmentResourceId, mode: component.mode, requiredCheckIds: component.requiredCheckIds }, graph);
 const binding: CombinedRecorder = { id: COMPONENT_BINDING_RECORDER, onEmit() {}, toSnapshot: () => ({ name: 'Agent component binding', data: componentBinding(definition, component) }) };
 return new AgentReadinessWorkflow({ definition: child, graph, store: new FileResourceFlowStore(join(directory, 'components', component.id)),
  profiles: ports.profiles, ...(ports.profileCatalogId ? { profileCatalogId: ports.profileCatalogId } : {}),
  ...(ports.requireProfileAtStart !== undefined ? { requireProfileAtStart: ports.requireProfileAtStart } : {}), adapters: ports.adapters, recorders: [binding] });
}
export function componentState(id: string, readiness: AgentReadinessState, live: boolean): AgentComponentState {
 if (readiness.status === 'idle') return { id, status: 'pending' };
 // A failed Create may have been accepted remotely before its result was lost.
 // Preserve the native failed capture, but never treat it as a safe failed attempt.
 if (readiness.definition.mode === 'create' && readiness.status === 'failed' && readiness.flow.failure?.stageId === 'acquire') return { id, status: 'incomplete', readiness };
 return { id, status: readiness.status === 'running' && !live ? 'incomplete' : readiness.status, readiness };
}
/** Small native parent result: complete references join child runs without embedding private config. */
export function componentReference(value: AgentComponentState) {
 return { id: value.id, status: value.status, ...(value.readiness ? { definitionDigest: value.readiness.definition.digest,
  executionId: value.readiness.flow.executionId, runs: Object.fromEntries(value.readiness.flow.segments.map(segment => [segment.runId, segment.status])),
  observationDigest: fingerprint({ events: value.readiness.flow.events, resource: value.readiness.flow.resource, connection: value.readiness.flow.connection, verification: value.readiness.flow.verification }) } : {}) };
}

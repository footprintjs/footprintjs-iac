import type { CombinedRecorder } from 'footprintjs';
import { ResourceFlowWorkflow } from '../resource-flow/workflow.ts';
import type { ResourceFlowProfiles } from '../resource-flow/profile-catalog.ts';
import type { FileResourceFlowStore } from '../resource-flow/store.ts';
import { agentEnvironmentPrimitives } from './adapters.ts';
import type { AgentDeployment, AgentEnvironmentAdapters } from './types.ts';

export const AGENT_BINDING_RECORDER_ID = 'iac-agent-revision-binding';
/** Sole composition point: reuses the base's native Create/Find → details/pause → Connect → Verify chart. */
export function createAgentReadinessFlow(options: {
 definition: AgentDeployment; store: FileResourceFlowStore; profiles: ResourceFlowProfiles; profileCatalogId?: string;
 requireProfileAtStart?: boolean; adapters: AgentEnvironmentAdapters; recorders?: readonly CombinedRecorder[];
}) {
 const definition = options.definition;
 if (options.recorders?.some(recorder => recorder.id === AGENT_BINDING_RECORDER_ID)) throw Error('Agent binding recorder ID is reserved');
 const binding: CombinedRecorder = { id: AGENT_BINDING_RECORDER_ID, onEmit() {}, toSnapshot: () => ({ name: 'Agent revision and infrastructure binding',
  description: 'Immutable declared behavior/runtime revision and infrastructure association. Runtime capabilities require measured verification.', data: { definition } }) };
 return new ResourceFlowWorkflow({ definition: { id: definition.id, label: definition.label, resourceId: definition.environmentResourceId,
  mode: definition.mode, target: definition.target, configurationDigest: definition.digest }, store: options.store, profiles: options.profiles,
  ...(options.profileCatalogId ? { profileCatalogId: options.profileCatalogId } : {}),
  ...(options.requireProfileAtStart !== undefined ? { requireProfileAtStart: options.requireProfileAtStart } : {}),
  adapters: agentEnvironmentPrimitives(definition, options.adapters), recorders: [binding, ...options.recorders ?? []] });
}

import type { ResourceFlowAdapters, ResourceFlowContext } from '../resource-flow/types.ts';
import { admitAgentVerification } from './verification.ts';
import type { AgentDeployment, AgentEnvironmentAdapters, AgentOperationContext } from './types.ts';

/** Narrow context decoration; every provider primitive stays inside the base native stage. */
export function agentEnvironmentPrimitives(definition: AgentDeployment, adapters: AgentEnvironmentAdapters): ResourceFlowAdapters {
 if (!adapters || ['find', 'resolveDetails', 'validate', 'connect', 'verify'].some(key => typeof adapters[key as keyof AgentEnvironmentAdapters] !== 'function')
  || definition.mode === 'create' && typeof adapters.create !== 'function') throw Error('Configure the registered agent environment primitives');
 const ports = Object.fromEntries(['create', 'find', 'resolveDetails', 'validate', 'connect', 'verify'].flatMap(key => {
  const method = adapters[key as keyof AgentEnvironmentAdapters]; return method ? [[key, method.bind(adapters)]] : [];
 })) as unknown as AgentEnvironmentAdapters;
 const context = (value: ResourceFlowContext): AgentOperationContext => Object.freeze({ ...value, agentId: definition.revision.agentId,
  revisionDigest: definition.revision.digest, deploymentId: definition.id, deploymentDigest: definition.digest });
 return {
  ...(ports.create ? { create: value => ports.create!(context(value)) } : {}),
  find: value => ports.find(context(value)),
  resolveDetails: (resource, profileId, value) => ports.resolveDetails(resource, profileId, context(value)),
  validate: (resource, details, value) => ports.validate(resource, details, context(value)),
  connect: (resource, details, value) => ports.connect(resource, details, context(value)),
  async verify(resource, details, connection, value) {
   const bound = context(value), request = { operationId: bound.operationId, agentId: bound.agentId, revisionDigest: bound.revisionDigest,
    environmentPhysicalId: resource.physicalId, scope: resource.scope };
   return admitAgentVerification(await ports.verify(resource, details, connection, bound), request, definition);
  },
 };
}

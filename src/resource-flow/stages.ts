import { interrupt } from 'footprintjs';
import { canonical, fingerprint } from '../util.ts';
import { readConnectionDetails, readFlowReceipt, readResourceHandle, readVerificationResult } from './data.ts';
import { ResourceFlowAdapterError } from './error.ts';
import type { ResourceFlowScope, ResourceFlowStageFunction } from './scope.ts';
import { RESOURCE_FLOW_EVENT, type ConnectionDetails, type ConnectionProfileChoice, type ResourceFlowAdapters,
  type ResourceFlowContext, type ResourceFlowDefinition, type ResourceFlowStageId, type ResourceFlowStageStatus, type ResourceHandle } from './types.ts';

export interface ResourceFlowStages {
  definition: ResourceFlowDefinition; definitionDigest: string; executionId: string; profiles: readonly ConnectionProfileChoice[];
  adapters: ResourceFlowAdapters;
  persist(scope: ResourceFlowScope): Promise<void>;
}
function context(scope: ResourceFlowScope, stageId: ResourceFlowStageId): ResourceFlowContext {
  const stored = scope.getValue('context') as ResourceFlowContext;
  return Object.freeze({ ...stored, operationId: fingerprint({ executionId: stored.executionId, stageId }) });
}
async function progress(scope: ResourceFlowScope, config: ResourceFlowStages, id: ResourceFlowStageId, status: ResourceFlowStageStatus) {
  const event = { executionId: config.executionId, stageId: id, status };
  scope.setValue('progress:' + id, event); scope.emitEvent(RESOURCE_FLOW_EVENT, event);
  await config.persist(scope);
}
/** Provider exceptions are normalized before they can reach the native executor or any recorder. */
async function safe<T>(scope: ResourceFlowScope, config: ResourceFlowStages, id: ResourceFlowStageId, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    scope.setValue('error', 'The ' + id + ' stage could not confirm its configured operation. Inspect the private adapter diagnostics.');
    scope.setValue('failure', { stageId: id, code: error instanceof ResourceFlowAdapterError ? error.code : 'adapter-operation-failed',
      ...(error instanceof ResourceFlowAdapterError && error.receipt ? { receipt: error.receipt } : {}) });
    await progress(scope, config, id, 'failed');
    throw Error('Resource flow ' + id + ' failed');
  }
}
function admittedHandle(config: ResourceFlowStages, input: unknown): ResourceHandle {
  const handle = readResourceHandle(input);
  if (handle.id !== config.definition.resourceId || handle.scope !== config.definition.target.scope) throw Error('Resource identity differs from the configured target');
  return handle;
}
async function validateLive(scope: ResourceFlowScope, config: ResourceFlowStages, id: ResourceFlowStageId, details?: ConnectionDetails): Promise<ResourceHandle> {
  const original = readResourceHandle(scope.getValue('resource'));
  const current = admittedHandle(config, await config.adapters.find(context(scope, id)));
  const identity = ({ id, kind, physicalId, scope }: ResourceHandle) => ({ id, kind, physicalId, scope });
  if (canonical(identity(original)) !== canonical(identity(current))) throw Error('The resource identity changed');
  scope.setValue('validatedResource', current);
  await config.adapters.validate(original, details, context(scope, id));
  return original;
}
function admittedDetails(config: ResourceFlowStages, resource: ResourceHandle, input: unknown, selected?: string): ConnectionDetails {
  const details = readConnectionDetails(input);
  if (details.resourceId !== resource.id || !config.profiles.some(profile => profile.id === details.profileId)
    || (selected !== undefined && details.profileId !== selected)) throw Error('Connection details differ from the selected resource and profile');
  return details;
}
export function acquireResourceStage(config: ResourceFlowStages): ResourceFlowStageFunction {
  return async scope => {
    scope.setValue('definition', config.definition); scope.setValue('definitionDigest', config.definitionDigest);
    scope.setValue('context', { executionId: config.executionId, operationId: fingerprint(config.executionId), definitionDigest: config.definitionDigest });
    await progress(scope, config, 'acquire', 'running');
    const resource = await safe(scope, config, 'acquire', async () => {
      const action = config.definition.mode === 'create' ? config.adapters.create : config.adapters.find;
      if (!action) throw Error('No resource creation adapter was configured');
      return admittedHandle(config, await action(context(scope, 'acquire')));
    });
    scope.setValue('resource', resource); await progress(scope, config, 'acquire', 'passed');
  };
}
/** The interrupt is deliberately outside adapter error normalization and outside every effectful stage. */
export function resolveDetailsStage(config: ResourceFlowStages): ResourceFlowStageFunction {
  return async scope => {
    await progress(scope, config, 'details', 'running');
    const resource = await safe(scope, config, 'details', () => validateLive(scope, config, 'details'));
    let details: ConnectionDetails | undefined;
    if (scope.getValue('awaitingProfile') !== true) {
      details = await safe(scope, config, 'details', async () => {
        const resolved = await config.adapters.resolveDetails(resource, undefined, context(scope, 'details'));
        return resolved === undefined ? undefined : admittedDetails(config, resource, resolved);
      });
    }
    if (!details) {
      scope.setValue('awaitingProfile', true); await progress(scope, config, 'details', 'waiting');
      const answer = interrupt<{ profileId: string }>(scope, { reason: 'Choose a connection profile', expects: { profileIds: config.profiles.map(profile => profile.id) } });
      details = await safe(scope, config, 'details', async () => {
        if (!answer || typeof answer !== 'object' || Object.keys(answer).length !== 1 || !config.profiles.some(profile => profile.id === answer.profileId)) throw Error('Unknown connection profile');
        const resolved = await config.adapters.resolveDetails(resource, answer.profileId, context(scope, 'details'));
        return admittedDetails(config, resource, resolved, answer.profileId);
      });
      scope.setValue('selectedProfileId', details.profileId); scope.setValue('awaitingProfile', false);
    }
    await safe(scope, config, 'details', () => config.adapters.validate(resource, details, context(scope, 'details')));
    scope.setValue('details', details); await progress(scope, config, 'details', 'passed');
  };
}
export function connectResourceStage(config: ResourceFlowStages): ResourceFlowStageFunction {
  return async scope => {
    await progress(scope, config, 'connect', 'running');
    const details = readConnectionDetails(scope.getValue('details'));
    const result = await safe(scope, config, 'connect', async () => {
      const resource = await validateLive(scope, config, 'connect', details);
      return readFlowReceipt(await config.adapters.connect(resource, details, context(scope, 'connect')));
    });
    scope.setValue('connection', result); await progress(scope, config, 'connect', 'passed');
  };
}
export function verifyResourceStage(config: ResourceFlowStages): ResourceFlowStageFunction {
  return async scope => {
    await progress(scope, config, 'verify', 'running');
    const resource = readResourceHandle(scope.getValue('resource')), details = readConnectionDetails(scope.getValue('details'));
    const connection = readFlowReceipt(scope.getValue('connection'));
    const verification = await safe(scope, config, 'verify', async () => readVerificationResult(await config.adapters.verify(resource, details, connection, context(scope, 'verify'))));
    scope.setValue('verification', verification);
    if (!verification.ok) scope.setValue('failure', { stageId: 'verify', code: 'verification-failed' });
    await progress(scope, config, 'verify', verification.ok ? 'passed' : 'failed');
    if (!verification.ok) throw Error('Resource flow verification failed');
  };
}

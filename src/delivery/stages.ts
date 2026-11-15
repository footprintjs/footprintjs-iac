import { canonical, fingerprint } from '../util.ts';
import {DeploymentPreflightRefused} from './evidence.ts';
import { readDeliveryBuild, readDeliveryDeployment, readDeliveryPlan, readDeliveryPublication,
  readDeliveryVerification, readSourceRevision, readSourceSnapshot } from './data.ts';
import { recordedDeliveryDefinition, recordedDeliveryResult } from './summary.ts';
import type { DeliveryScope, DeliveryStageFunction } from './scope.ts';
import { DELIVERY_EVENT, type DeliveryAdapters, type DeliveryContext, type DeliveryDefinition, type DeliveryResults, type DeliveryStageId, type SourceRevision } from './types.ts';

export interface SourceBuildStages {
  definition: DeliveryDefinition; definitionDigest: string; executionId: string; adapters: Pick<DeliveryAdapters, 'source' | 'build' | 'artifacts'>; results: DeliveryResults;
  persist(): Promise<void>;
  /** Optional host selection pin, included by the caller in its durable definition digest. */
  expectedRevision?: SourceRevision;
}
export interface DeliveryStages extends SourceBuildStages { adapters: DeliveryAdapters }
function context(config: SourceBuildStages, id: DeliveryStageId): DeliveryContext {
  return Object.freeze({ executionId: config.executionId, operationId: fingerprint({ executionId: config.executionId, stageId: id }),
    definitionDigest: config.definitionDigest, target: config.definition.target });
}
async function progress(scope: DeliveryScope, config: SourceBuildStages, stageId: DeliveryStageId, status: 'running' | 'passed' | 'failed') {
  const event = { executionId: config.executionId, stageId, status };
  scope.setValue('progress:' + stageId, event); scope.emitEvent(DELIVERY_EVENT, event);
  await config.persist(); // Stage intent is synced before invoking an adapter.
}
function consume(scope: DeliveryScope, config: SourceBuildStages, key: keyof DeliveryResults): void {
  if (canonical(scope.getValue(key)) !== canonical(recordedDeliveryResult(key, config.results))) throw Error('Recorded delivery input does not match its host receipt');
}
function stage(config: SourceBuildStages, id: DeliveryStageId, key: keyof DeliveryResults, inputs: (keyof DeliveryResults)[], work: () => Promise<unknown>): DeliveryStageFunction {
  return async scope => {
    if (id === 'resolve') { scope.setValue('definition', recordedDeliveryDefinition(config.definition)); scope.setValue('executionId', config.executionId);
      if(config.expectedRevision)scope.setValue('expectedSource',recordedDeliveryResult('revision',{revision:config.expectedRevision})); }
    await progress(scope, config, id, 'running');
    try {
      if (canonical(scope.getValue('definition')) !== canonical(recordedDeliveryDefinition(config.definition))) throw Error('Recorded delivery definition differs from its host binding');
      if(id==='resolve'&&config.expectedRevision&&canonical(scope.getValue('expectedSource'))!==canonical(recordedDeliveryResult('revision',{revision:config.expectedRevision})))throw Error('Recorded reviewed source changed');
      for (const input of inputs) consume(scope, config, input);
      await work();
      scope.setValue(key, recordedDeliveryResult(key, config.results));
      if (key === 'deployment' && !config.results.deployment!.ok || key === 'verification' && !config.results.verification!.ok) throw Error('The configured operation did not confirm success');
      await progress(scope, config, id, 'passed');
    } catch (error) {
      if (config.results[key] !== undefined) scope.setValue(key, recordedDeliveryResult(key, config.results));
      scope.setValue('failure', { stageId: id, code: 'delivery-stage-failed',...(error instanceof DeploymentPreflightRefused?{evidence:error.evidence}:{}) });
      await progress(scope, config, id, 'failed');
      throw Error('The delivery ' + id + ' stage did not confirm success. Inspect private adapter diagnostics.');
    }
  };
}
export function resolveSourceStage(config: SourceBuildStages): DeliveryStageFunction {
  return stage(config, 'resolve', 'revision', [], async () => {
    const result = readSourceRevision(await config.adapters.source.resolve(config.definition.source, context(config, 'resolve')));
    if (result.repository !== config.definition.source.repository || result.ref !== config.definition.source.ref) throw Error('Resolved source differs from the configured repository and ref');
    if(config.expectedRevision&&canonical(result)!==canonical(config.expectedRevision))throw Error('Resolved source differs from the reviewed commit and tree');
    config.results.revision = result;
  });
}
export function fetchSourceStage(config: SourceBuildStages): DeliveryStageFunction {
  return stage(config, 'fetch', 'source', ['revision'], async () => {
    const result = readSourceSnapshot(await config.adapters.source.fetch(config.results.revision!, context(config, 'fetch')));
    if (canonical(result.revision) !== canonical(config.results.revision)) throw Error('Fetched source differs from the resolved immutable revision');
    config.results.source = result;
  });
}
export function buildSourceStage(config: SourceBuildStages): DeliveryStageFunction {
  return stage(config, 'build', 'build', ['source'], async () => {
    const result = readDeliveryBuild(await config.adapters.build.build(config.results.source!, config.definition.recipe, context(config, 'build')));
    if (result.recipeDigest !== config.definition.recipe.digest) throw Error('Build recipe differs from the configured recipe');
    config.results.build = result;
  });
}
export function publishArtifactsStage(config: SourceBuildStages): DeliveryStageFunction {
  return stage(config, 'publish', 'publication', ['build'], async () => {
    const result = readDeliveryPublication(await config.adapters.artifacts.publish(config.results.build!, context(config, 'publish')));
    const identity = (items: { id: string; digest: string }[]) => items.map(({ id, digest }) => ({ id, digest })).sort((a,b) => a.id.localeCompare(b.id));
    if (canonical(identity(result.artifacts)) !== canonical(identity(config.results.build!.artifacts))) throw Error('Published artifacts differ from the built content');
    config.results.publication = result;
  });
}
export function planDeliveryStage(config: DeliveryStages): DeliveryStageFunction {
  return stage(config, 'plan', 'plan', ['publication'], async () => { config.results.plan = readDeliveryPlan(await config.adapters.deployment.plan(config.results.publication!, context(config, 'plan'))); });
}
export function deployDeliveryStage(config: DeliveryStages): DeliveryStageFunction {
  return stage(config, 'deploy', 'deployment', ['plan'], async () => { config.results.deployment = readDeliveryDeployment(await config.adapters.deployment.deploy(config.results.plan!, context(config, 'deploy'))); });
}
export function verifyDeliveryStage(config: DeliveryStages): DeliveryStageFunction {
  return stage(config, 'verify', 'verification', ['deployment'], async () => { config.results.verification = readDeliveryVerification(await config.adapters.deployment.verify(config.results.deployment!, context(config, 'verify'))); });
}

import { readBootstrapActionReceipt, readBootstrapRevalidation } from '../platform-bootstrap/data.ts';
import { canonical } from '../util.ts';
import { readResourceHandle } from '../resource-flow/data.ts';
import { readHostFactsSnapshot } from '../platform-access/facts.ts';
import { admitMutationHosts, contextFor, discoverFacts, persist, safeStage, type PlatformStages } from './stages.ts';

export function refreshActionFactsStage(config: PlatformStages, actionId: string) {
  return safeStage(config, 'platform-discovery-failed', async scope => {
    if (canonical(scope.getValue('hosts')) !== canonical(config.options.hosts)) throw Error();
    scope.setValue(`facts:${actionId}`, await discoverFacts(config, `discover-${actionId}`));
  });
}
export function revalidateActionStage(config: PlatformStages, actionId: string) {
  return safeStage(config, 'platform-revalidation-failed', async scope => {
    const action = config.state.actions.find(value => value.id === actionId);
    if (!action || action.status !== 'pending' || canonical(scope.getValue('plan')) !== canonical(config.state.plan)) throw Error();
    const factsValue = scope.getValue(`facts:${actionId}`);
    if (!Array.isArray(factsValue)) throw Error();
    const facts = factsValue.map(readHostFactsSnapshot);
    for (const completed of config.state.actions.filter(value => value.status === 'completed')) {
      if (canonical(scope.getValue('receipt:' + completed.id)) !== canonical(completed.receipt)) throw Error();
    }
    admitMutationHosts(config, config.state.plan!, facts);
    const revalidated = readBootstrapRevalidation(await config.options.lifecycle.revalidate(config.state.plan!, config.options.intent, facts, contextFor(config, `revalidate-${actionId}`)));
    scope.setValue(`revalidation:${actionId}`, revalidated);
    if (!revalidated.valid || revalidated.planDigest !== config.state.plan!.digest) throw Error();
  });
}
export function intendActionStage(config: PlatformStages, actionId: string) {
  return safeStage(config, 'platform-intent-failed', async scope => {
    const validation = readBootstrapRevalidation(scope.getValue(`revalidation:${actionId}`));
    const action = config.state.actions.find(value => value.id === actionId);
    if (!action || action.status !== 'pending' || !validation.valid || validation.planDigest !== config.state.plan!.digest) throw Error();
    // Every individual remote mutation receives durable intent before its execution call.
    action.status = 'started'; await persist(config);
    scope.setValue(`intent:${actionId}`, { actionId, planDigest: config.state.plan!.digest, operationId: contextFor(config, `execute-${actionId}`).operationId });
  });
}
export function executeActionStage(config: PlatformStages, actionId: string) {
  return safeStage(config, 'platform-action-uncertain', async scope => {
    const action = config.state.actions.find(value => value.id === actionId);
    const intent = scope.getValue(`intent:${actionId}`) as { actionId?: string; planDigest?: string; operationId?: string } | undefined;
    const context = contextFor(config, `execute-${actionId}`);
    if (!action || action.status !== 'started' || intent?.actionId !== actionId || intent.planDigest !== config.state.plan!.digest || intent.operationId !== context.operationId) throw Error();
    try {
      const receipt = readBootstrapActionReceipt(await config.options.lifecycle.executeAction(config.state.plan!, actionId, context));
      if (receipt.actionId !== actionId || receipt.hostId !== action.hostId || receipt.status !== 'completed') throw Error();
      const planned = config.state.plan!.actions.find(value => value.id === actionId)!;
      if (planned.phase === 'initialize' && !receipt.resource) throw Error();
      if (receipt.resource) {
        const resource = readResourceHandle(receipt.resource);
        if (resource.id !== config.options.definition.resourceId || resource.scope !== config.options.definition.target.scope
          || config.state.resource && canonical({ ...config.state.resource, receipt: undefined }) !== canonical({ ...resource, receipt: undefined })) throw Error();
        config.state.resource = resource;
      }
      action.receipt = receipt; action.status = 'completed';
      scope.setValue(`receipt:${actionId}`, receipt); await persist(config);
    } catch {
      // Even a thrown/invalid receipt may follow an accepted remote command. Never replay it.
      action.status = 'uncertain'; await persist(config); throw Error('Platform action outcome uncertain');
    }
  });
}

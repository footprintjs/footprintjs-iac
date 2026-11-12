import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
export class ResourceFlowScope extends ScopeFacade {}
export const resourceFlowScopeFactory: ScopeFactory<ResourceFlowScope> = (context, name, readOnly, environment) =>
  new ResourceFlowScope(context, name, readOnly, environment);
export type ResourceFlowStageFunction = (scope: ResourceFlowScope) => void | Promise<void>;

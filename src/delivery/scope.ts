import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
export class DeliveryScope extends ScopeFacade {}
export const deliveryScopeFactory: ScopeFactory<DeliveryScope> = (context, name, readOnly, environment) =>
  new DeliveryScope(context, name, readOnly, environment);
export type DeliveryStageFunction = (scope: DeliveryScope) => Promise<void>;

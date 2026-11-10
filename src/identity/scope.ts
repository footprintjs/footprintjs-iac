import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
export class IdentityScope extends ScopeFacade {
  get checkPassed(): boolean { return this.getValue('checkPassed') as boolean; }
}
export const identityScopeFactory: ScopeFactory<IdentityScope> = (context, name, readOnly, environment) =>
  new IdentityScope(context, name, readOnly, environment);
export type IdentityStage = (scope: IdentityScope) => void | Promise<void>;

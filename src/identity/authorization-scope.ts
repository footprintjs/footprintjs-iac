import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
export class AuthorizationScope extends ScopeFacade {
  get accessAllowed(): boolean { return this.getValue('accessAllowed') as boolean; }
}
export const authorizationScopeFactory: ScopeFactory<AuthorizationScope> = (context, name, readOnly, environment) =>
  new AuthorizationScope(context, name, readOnly, environment);
export type AuthorizationStage = (scope: AuthorizationScope) => void | Promise<void>;

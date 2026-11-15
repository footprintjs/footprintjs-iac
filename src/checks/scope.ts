import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
export class CheckScope extends ScopeFacade {}
export const checkScopeFactory: ScopeFactory<CheckScope> = (context, name, readOnly, environment) =>
  new CheckScope(context, name, readOnly, environment);

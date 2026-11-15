import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
export class PlatformScope extends ScopeFacade {}
export const platformScopeFactory: ScopeFactory<PlatformScope> = (context, name, readOnly, environment) =>
  new PlatformScope(context, name, readOnly, environment);

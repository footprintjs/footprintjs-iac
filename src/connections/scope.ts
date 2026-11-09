import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';

/** Only the most recent serial probe drives the following recorded decision. */
export class ConnectionScope extends ScopeFacade {
  get probeFailed(): boolean { return this.getValue('probeFailed') as boolean; }
}
export const connectionScopeFactory: ScopeFactory<ConnectionScope> = (context, name, readOnly, environment) =>
  new ConnectionScope(context, name, readOnly, environment);
export type ConnectionStage = (scope: ConnectionScope) => void | Promise<void>;

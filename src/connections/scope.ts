import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
import type { ConnectionCheckResult } from './types.ts';

/** Only the most recent serial probe drives the following recorded decision. */
export class ConnectionScope extends ScopeFacade {
  get probeFailed(): boolean {
    const id = this.getValue('activeConnectionId');
    if (typeof id !== 'string') throw Error('A connection decision needs its current recorded result');
    const result = this.getValue(`result:${id}`) as ConnectionCheckResult | undefined;
    if (!result || result.connectionId !== id || !['connected', 'failed'].includes(result.status)) throw Error('A connection decision needs its current recorded result');
    return result.status === 'failed';
  }
}
export const connectionScopeFactory: ScopeFactory<ConnectionScope> = (context, name, readOnly, environment) =>
  new ConnectionScope(context, name, readOnly, environment);
export type ConnectionStage = (scope: ConnectionScope) => void | Promise<void>;

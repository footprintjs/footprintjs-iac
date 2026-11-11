import { ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
import type { IdentityCheckResult } from './types.ts';
export class IdentityScope extends ScopeFacade {
  get checkPassed(): boolean {
    const id = this.getValue('activeCheckId');
    if (typeof id !== 'string') throw Error('An identity decision needs its current recorded result');
    const result = this.getValue(`result:${id}`) as IdentityCheckResult | undefined;
    if (!result || result.checkId !== id || !['passed', 'failed'].includes(result.status)) throw Error('An identity decision needs its current recorded result');
    return result.status === 'passed';
  }
}
export const identityScopeFactory: ScopeFactory<IdentityScope> = (context, name, readOnly, environment) =>
  new IdentityScope(context, name, readOnly, environment);
export type IdentityStage = (scope: IdentityScope) => void | Promise<void>;

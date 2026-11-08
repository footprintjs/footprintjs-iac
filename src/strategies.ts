import type { FailureDecision, FailureStrategy, Observation } from './types.ts';

/** Stop on unknown observations; retry only through an adapter declaring idempotent/stable identity. */
export class ReconcileStrategy implements FailureStrategy {
  readonly maxAttempts: number;
  constructor(maxAttempts = 2) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('maxAttempts must be 1..10');
    this.maxAttempts = maxAttempts;
  }
  decide(_error: unknown, observation: Observation | undefined, attempt: number): FailureDecision {
    if (!observation) return { retry: false, reason: 'Provider outcome unknown; stop and reconcile later' };
    if (observation.exists && observation.owned !== true) return { retry: false, reason: 'Resource ownership changed' };
    return { retry: attempt < this.maxAttempts, reason: attempt < this.maxAttempts ? 'Observed provider; retry same resource identity' : 'Attempt limit reached' };
  }
}

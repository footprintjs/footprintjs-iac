import type { JournalEntry, StackState, StateStore } from '../types.ts';
import { errorMessage } from '../util.ts';

export class PersistenceError extends Error {}

/** One run owns this queue under the whole-stack lock. A durable failure poisons later work. */
export class ExecutionPersistence {
  private tail: Promise<void> = Promise.resolve();
  private failure: PersistenceError | undefined;
  private readonly store: StateStore;

  constructor(store: StateStore) { this.store = store; }

  save(state: StackState): Promise<void> {
    // Capture now, not when the queue reaches this save: siblings may mutate shared state meanwhile.
    const snapshot = structuredClone(state);
    return this.enqueue(() => this.store.save(snapshot));
  }

  append(entry: JournalEntry): Promise<void> {
    const snapshot = structuredClone(entry);
    return this.enqueue(() => this.store.append(snapshot));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      try { await work(); }
      catch (error) {
        this.failure = new PersistenceError(`Durable recording failed: ${errorMessage(error)}`, { cause: error });
        throw this.failure;
      }
    });
    // Observe every rejection here while each caller still receives its own rejecting promise.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

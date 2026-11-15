import { join } from 'node:path';
import { FileStateStore } from '../../../src/store.ts';
import type { DeliveryState } from '../../../src/delivery/types.ts';

export interface NeoDeliveryControl {
  snapshot(): Promise<DeliveryState>;
  start(): Promise<DeliveryState>;
  subscribe(listener: (state: DeliveryState) => void): () => void;
}

/** A local target has one delivery owner through build, master promotion, publication and checks. */
export function lockNeoDeliveryTarget(directory: string, workflow: NeoDeliveryControl,
  admitCurrentTarget: () => Promise<void>): NeoDeliveryControl {
  const lock = new FileStateStore(join(directory, 'delivery-execution-locks'));
  return {
    snapshot: workflow.snapshot.bind(workflow), subscribe: workflow.subscribe.bind(workflow),
    start() {
      return lock.withLock('github-delivery', async () => {
        if ((await workflow.snapshot()).status === 'idle') await admitCurrentTarget();
        return workflow.start();
      });
    },
  };
}

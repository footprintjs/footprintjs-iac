import { identifier } from '../graph/data.ts';
import { readFlowReceipt } from './data.ts';
import type { FlowReceipt } from './types.ts';

/** A bounded public failure code and optional native child receipt; never attach a raw provider error. */
export class ResourceFlowAdapterError extends Error {
  readonly code: string;
  readonly receipt?: FlowReceipt;
  constructor(code: string, receipt?: FlowReceipt) {
    super('A resource flow adapter reported a recorded failure'); this.name = 'ResourceFlowAdapterError';
    this.code = identifier(code, 'safe adapter failure code');
    if (receipt !== undefined) this.receipt = readFlowReceipt(receipt);
    Object.freeze(this);
  }
}

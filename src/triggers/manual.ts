import { readTriggerDefinition } from './data.ts';
import type { TriggerAdapter, TriggerDefinition, TriggerSignal } from './types.ts';

export class ManualTriggerAdapter implements TriggerAdapter {
  readonly kind = 'manual' as const;
  readonly id: string;
  constructor(id = 'manual') { this.id = id; }
  admit(input: TriggerDefinition): void { if (readTriggerDefinition(input).kind !== this.kind) throw Error('Manual adapter requires a manual trigger'); }
  async prepare({ definition, now, signal }: { definition: TriggerDefinition; now: number; signal?: TriggerSignal }) {
    this.admit(definition);
    if (!signal?.requestId || signal.event) throw Error('Manual checks require a stable request ID');
    return { dedupeKey: 'manual:' + signal.requestId, scheduledAt: now, reason: 'manual' as const, dispatch: true };
  }
}

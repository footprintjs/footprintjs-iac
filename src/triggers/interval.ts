import { readTriggerDefinition } from './data.ts';
import type { TriggerAdapter, TriggerDefinition, TriggerSignal } from './types.ts';

/** A host's scheduler calls tick. This adapter owns no timers and never replays a missed backlog. */
export class IntervalTriggerAdapter implements TriggerAdapter {
  readonly kind = 'interval' as const;
  readonly id: string;
  constructor(id = 'interval') { this.id = id; }
  admit(input: TriggerDefinition): void { if (readTriggerDefinition(input).kind !== this.kind) throw Error('Interval adapter requires an interval trigger'); }
  async prepare({ definition, now, nextDueAt, signal }: { definition: TriggerDefinition; now: number; nextDueAt?: number; signal?: TriggerSignal }) {
    this.admit(definition); if (signal && Object.keys(signal).length) throw Error('A scheduled tick takes no client signal');
    const schedule = definition.schedule!, due = nextDueAt ?? schedule.startsAt;
    if (now < due) return;
    const elapsed = Math.floor((now - due) / schedule.everyMs), next = due + (elapsed + 1) * schedule.everyMs;
    if (!Number.isSafeInteger(next)) throw Error('Schedule exceeded its finite time range');
    return { dedupeKey: 'interval:' + due, scheduledAt: due, reason: 'scheduled' as const,
      nextDueAt: next, dispatch: elapsed === 0 || definition.missed === 'coalesce' };
  }
}

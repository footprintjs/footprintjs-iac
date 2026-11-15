import { canonical } from '../util.ts';
import { readStageCompletion, readTriggerDefinition } from './data.ts';
import type { StageCompletion, StageEventReference, TriggerAdapter, TriggerDefinition, TriggerSignal } from './types.ts';

export interface StageEventReader { read(reference: StageEventReference): Promise<StageCompletion | undefined> }
/** Event payloads are only references. A trusted host reloads the bound native stage receipt. */
export class StageEventTriggerAdapter implements TriggerAdapter {
  readonly kind = 'stage-event' as const;
  readonly id: string; private readonly reader: StageEventReader;
  constructor(id: string, reader: StageEventReader) { this.id = id; this.reader = reader; }
  admit(input: TriggerDefinition): void { if (readTriggerDefinition(input).kind !== this.kind) throw Error('Stage adapter requires a stage event trigger'); }
  async prepare({ definition, now, signal }: { definition: TriggerDefinition; now: number; signal?: TriggerSignal }) {
    this.admit(definition); const reference = signal?.event;
    if (!reference || signal?.requestId || reference.pipelineId !== definition.source!.pipelineId
      || reference.definitionDigest !== definition.source!.definitionDigest || reference.stageId !== definition.stageId) throw Error('Stage event does not match its bound trigger');
    const raw = await this.reader.read(reference);
    if (!raw) throw Error('Stage event is absent, stale or unverified');
    const completion = readStageCompletion(raw);
    if (canonical(completion.reference) !== canonical(reference) || canonical(completion.target) !== canonical(definition.target)) throw Error('Stage event receipt differs from its registered target');
    return { dedupeKey: 'stage:' + reference.executionId + ':' + reference.sequence, scheduledAt: now,
      reason: 'after-deploy' as const, dispatch: true, completion };
  }
}

import { canonical } from '../util.ts';
import { readPipelineState } from '../pipeline/data.ts';
import { loadPipelineRecording } from '../pipeline/recording.ts';
import { recordedStage } from '../pipeline/summary.ts';
import type { PipelineState } from '../pipeline/types.ts';
import { readStageEventReference } from './data.ts';
import type { StageEventReader } from './stage-event.ts';

/** Host-only bridge: load via the bound PipelineWorkflow.snapshot(), never from a browser event body. */
export function pipelineStageEventReader(load: (pipelineId: string) => Promise<PipelineState | undefined>): StageEventReader {
  return { async read(input) {
    const reference = readStageEventReference(input), raw = await load(reference.pipelineId); if (!raw) return;
    const state = readPipelineState(raw);
    if (state.definition.id !== reference.pipelineId || state.definitionDigest !== reference.definitionDigest || state.executionId !== reference.executionId) return;
    const event = state.events.find(event => event.sequence === reference.sequence), stage = state.stages.find(stage => stage.id === reference.stageId);
    if (!event || event.stageId !== reference.stageId || event.executionId !== reference.executionId || event.status !== 'passed' || event.phase !== 'outcome'
      || !stage || stage.status !== 'passed' || stage.lastVerified !== state.release.digest) return;
    const receipt = state.recordings.findLast(receipt => receipt.stageId === reference.stageId && receipt.kind === 'rollout' && receipt.status === 'passed');
    if (!receipt) return;
    const recording = await loadPipelineRecording(receipt.evidencePath, { runId: receipt.runId, definitionDigest: reference.definitionDigest, executionId: reference.executionId, stageId: reference.stageId });
    const shared = (recording.snapshot as { sharedState?: Record<string, unknown> }).sharedState;
    if (recording.status !== 'passed' || !shared || shared.executionId !== reference.executionId || shared.releaseDigest !== state.release.digest
      || canonical(shared.stage) !== canonical(recordedStage(stage))) return;
    return { reference, target: state.definition.stages.find(stage => stage.id === reference.stageId)!.target,
      releaseId: state.release.id, releaseDigest: state.release.digest, status: 'passed' };
  } };
}

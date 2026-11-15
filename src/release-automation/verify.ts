import {canonical} from '../util.ts';
import {readReleaseManifest} from '../releases/manifest.ts';
import {readReleasePreparationState} from '../releases/preparation-data.ts';
import {loadReleaseBuildRecording} from '../releases/recording.ts';
import {recordedDeliveryDefinition,recordedDeliveryResult} from '../delivery/summary.ts';
import {readPipelineState} from '../pipeline/data.ts';
import {loadPipelineRecording} from '../pipeline/recording.ts';
import {recordedStage,recordedOperation} from '../pipeline/summary.ts';
import type {ReleasePreparationState} from '../releases/preparation-types.ts';
import type {PipelineState} from '../pipeline/types.ts';
import type {ResolvedReleaseChoice} from '../releases/types.ts';

export async function verifiedPreparation(input:ReleasePreparationState,choice:ResolvedReleaseChoice):Promise<ReleasePreparationState>{
  const state=readReleasePreparationState(input);
  if(state.definition.source.repository!==choice.source.repository||state.definition.source.ref!==choice.source.ref||canonical(state.expectedRevision)!==canonical(choice.source))throw Error('Release build must bind the exact catalog source');
  if(state.status!=='passed')return state;
  if(!state.release||canonical(state.results.revision)!==canonical(choice.source)||canonical(state.release.source)!==canonical(choice.source)||!state.executionId||!state.recordings.length)throw Error('Prepared source differs from selection');
  readReleaseManifest(state.release);
  const receipt=state.recordings.at(-1)!,loaded=await loadReleaseBuildRecording(receipt.evidencePath,receipt.tracePath,{runId:receipt.runId,definitionDigest:state.definitionDigest,executionId:state.executionId});
  const shared=(loaded.snapshot as {sharedState?:Record<string,unknown>}).sharedState;
  if(receipt.status!=='passed'||loaded.status!=='passed'||!shared||canonical(shared.definition)!==canonical(recordedDeliveryDefinition(state.definition))
    ||Object.keys(state.results).some(key=>canonical(shared[key])!==canonical(recordedDeliveryResult(key as keyof typeof state.results,state.results))))throw Error('Prepared release lacks matching native evidence');
  return state;
}
export async function verifiedPipeline(input:PipelineState,prepared:ReleasePreparationState):Promise<PipelineState>{
  const state=readPipelineState(input);if(!prepared.release||canonical(state.release)!==canonical(prepared.release))throw Error('Pipeline must consume exact prepared release');
  if(state.status==='idle')return state;
  if(!state.executionId||!state.recordings.length)throw Error('Pipeline has no retained native outcome');
  for(const stage of state.stages){const receipt=state.recordings.findLast(item=>item.stageId===stage.id);if(!receipt){if(stage.status!=='pending')throw Error('Pipeline stage lacks native evidence');continue;}
    let loaded:Awaited<ReturnType<typeof loadPipelineRecording>>;try{loaded=await loadPipelineRecording(receipt.evidencePath,{runId:receipt.runId,definitionDigest:state.definitionDigest,executionId:state.executionId,stageId:stage.id});}catch(error){if(receipt.status==='incomplete'&&stage.status==='incomplete')continue;throw error;}
    const shared=(loaded.snapshot as {sharedState?:Record<string,unknown>}).sharedState;
    const recorded=shared?.stage as {operations?:unknown[]}|undefined;
    if(!shared||loaded.status!==receipt.status||!recorded||!Array.isArray(recorded.operations)||canonical(recorded.operations)!==canonical(stage.operations.slice(0,recorded.operations.length).map(recordedOperation))
      ||!['running','incomplete'].includes(stage.status)&&canonical(shared.stage)!==canonical(recordedStage(stage)))throw Error('Pipeline outcome differs from native recording');}
  return state;
}

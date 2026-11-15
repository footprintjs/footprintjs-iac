import type { ReleaseCatalog, ReleaseChoice, ResolvedReleaseChoice } from '../releases/types.ts';
import type { ReleasePreparationState } from '../releases/preparation-types.ts';
import type { PipelineActionRequest, PipelineState, PipelineWorkflowPort } from '../pipeline/types.ts';

export interface ReleaseAutomationDefinition {
  version:1;id:string;label:string;catalogId:string;adapterId:string;configurationDigest:string;
  automatic:{enabled:boolean;initial:'observe'|'latest'};
}
export interface ReleaseAutomationContext {attemptId:string;definitionDigest:string;directory:string}
export interface ReleasePreparationPort {
  snapshot():Promise<ReleasePreparationState>;start():Promise<ReleasePreparationState>;
  subscribe(listener:(state:ReleasePreparationState)=>void):()=>void;
}
/** Factories reconstruct immutable child workflows; they must never deploy while constructing. */
export interface ReleaseAutomationAdapter {
  id:string;
  prepare(choice:ResolvedReleaseChoice,context:ReleaseAutomationContext):Promise<ReleasePreparationPort>;
  pipeline(prepared:ReleasePreparationState,context:ReleaseAutomationContext):Promise<PipelineWorkflowPort>;
}
export interface ReleaseSelectionStrategy {
  id:string;
  select(input:{choices:readonly ReleaseChoice[];eligibleIds:readonly string[]}):string|undefined;
}
export type ReleaseAutomationAttemptStatus='reserved'|'resolving'|'preparing'|'deploying'|'waiting'|'passed'|'failed'|'incomplete'|'skipped';
export interface ReleaseAutomationRecording {runId:string;evidencePath:string;tracePath:string;complete:boolean;attemptId?:string}
export interface ReleaseAutomationAttempt {
  id:string;releaseId:string;trigger:'manual'|'automatic';status:ReleaseAutomationAttemptStatus;createdAt:number;
  source?:ResolvedReleaseChoice;sourceDigest?:string;duplicateOf?:string;
  preparation?:ReleasePreparationState;pipeline?:PipelineState;recordings:ReleaseAutomationRecording[];
  reason?:string;
}
export interface ReleaseAutomationState {
  version:1;kind:'release-automation';definition:ReleaseAutomationDefinition;definitionDigest:string;
  initialized:boolean;choices:ReleaseChoice[];seenIds:string[];attempts:ReleaseAutomationAttempt[];
  recordings:ReleaseAutomationRecording[];lastRefreshAt?:number;discoveryStatus:'not-checked'|'available'|'unavailable';
}
export interface ReleaseAutomationPort {
  snapshot():Promise<ReleaseAutomationState>;refresh():Promise<ReleaseAutomationState>;
  tick():Promise<ReleaseAutomationState>;start(releaseId:string):Promise<ReleaseAutomationState>;
  promote(attemptId:string,request:PipelineActionRequest):Promise<ReleaseAutomationState>;
  recover(attemptId:string,request:PipelineActionRequest):Promise<ReleaseAutomationState>;
  subscribe(listener:(state:ReleaseAutomationState)=>void):()=>void;
}
export interface ReleaseAutomationOptions {
  definition:ReleaseAutomationDefinition;catalog:ReleaseCatalog;adapter:ReleaseAutomationAdapter;
  strategy?:ReleaseSelectionStrategy;clock?:()=>number;
}

import type { Observation,Resource } from '../types.ts';

export const CHANGE_ASSESSMENT_EVENT='iac:change-assessment';
export type ChangeDisposition='noop'|'verify'|'create'|'update'|'replace'|'delete'|'blocked'|'unknown';
export type DataImpact='stateless'|'stateful'|'unknown';
export interface AssessmentTarget{id:string;scope:string}
export interface ResourceChange {
  id:string;label:string;adapterId:string;strategyId:string;data:DataImpact;
  previous?:Resource;desired?:Resource;
}
export interface ChangeAssessmentDefinition {
  version:1;id:string;label:string;target:AssessmentTarget;configurationDigest:string;changes:ResourceChange[];
}
export interface ChangeAssessmentContext {executionId:string;operationId:string;definitionDigest:string;target:AssessmentTarget}
export interface AssessmentObservation extends Observation {revision?:string}
/** Provider reads and validation/dry-run only. Never apply, remove, provision or alter connection routing. */
export interface ChangeProbe {
  observation:AssessmentObservation;
  destination?:AssessmentObservation;
  update:'supported'|'replacement-required'|'rejected'|'unknown'|'not-needed';
  reasons:string[];
  /** A dry-run is point-in-time evidence; it is never an unconditional promise of a later update. */
  validation:'provider-dry-run'|'declared-contract'|'not-checked';
  /** Host-approved schema paths only; no dynamic user keys or provider error strings. */
  changedPaths?:string[];
  requirements?:string[];
}
export interface ChangeAssessmentAdapter {
  id:string;provider:string;scope:string;
  probe(change:ResourceChange,context:ChangeAssessmentContext):Promise<ChangeProbe>;
}
export interface ChangeAssessmentStrategy {
  id:string;label:string;
  /** Pure classification over already measured provider facts. */
  classify(change:ResourceChange,probe:ChangeProbe):{disposition:ChangeDisposition;reasons:string[]};
}
export interface ChangeAssessmentRegistry {adapters:readonly ChangeAssessmentAdapter[];strategies:readonly ChangeAssessmentStrategy[]}
/** Public projection contains hashes and reason codes, never resource values, endpoints or provider error bodies. */
export interface AssessedResourceChange {
  id:string;label:string;resourceId:string;provider:string;adapterId:string;strategyId:string;data:DataImpact;
  previousDigest:string|null;desiredDigest:string|null;changedPaths:string[];
  disposition:ChangeDisposition;reasons:string[];validation:ChangeProbe['validation'];
  observed:{exists:boolean;owned?:boolean;ready?:boolean;identityDigest?:string;revisionDigest?:string;fingerprint?:string};
  requirements:string[];
}
export interface ChangeAssessmentReport {
  kind:'change-assessment';schemaVersion:1;id:string;label:string;
  target:{id:string;scopeDigest:string};definitionDigest:string;executionId:string;assessedAt:number;
  changes:AssessedResourceChange[];digest:string;
}
export interface ChangeAssessmentEvent {
  sequence:number;executionId:string;changeId:string;status:'checking'|'checked';timestamp:number;runtimeStageId:string;
}
export interface ChangeAssessmentState {
  version:1;kind:'change-assessment-state';definition:ChangeAssessmentDefinition;definitionDigest:string;executionId:string|null;
  status:'idle'|'running'|'complete'|'incomplete';events:ChangeAssessmentEvent[];
  decisions:AssessedResourceChange[];report?:ChangeAssessmentReport;
  recording?:{runId:string;evidencePath:string;tracePath:string;complete:boolean};error?:string;
}
export interface ChangeAssessmentWorkflowPort {
  snapshot():Promise<ChangeAssessmentState>;start():Promise<ChangeAssessmentState>;
  subscribe(listener:(state:ChangeAssessmentState)=>void):()=>void;
}

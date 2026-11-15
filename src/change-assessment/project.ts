import {canonical,fingerprint} from '../util.ts';
import {readAssessedChange,codes,dispositions,readChangeProbe} from './data.ts';
import {admitChangeDisposition} from './strategy.ts';
import type {AssessedResourceChange,ChangeAssessmentDefinition,ChangeAssessmentStrategy,ChangeProbe,ResourceChange} from './types.ts';

export function recordedAssessmentDefinition(definition:ChangeAssessmentDefinition){return{id:definition.id,label:definition.label,
  targetId:definition.target.id,scopeDigest:fingerprint(definition.target.scope),configurationDigest:definition.configurationDigest,
  changes:definition.changes.map(change=>({id:change.id,label:change.label,adapterId:change.adapterId,strategyId:change.strategyId,data:change.data,
    previousDigest:change.previous?fingerprint(change.previous):null,desiredDigest:change.desired?fingerprint(change.desired):null}))};}
export type AssessmentClassification=ReturnType<ChangeAssessmentStrategy['classify']>;
export function readAssessmentClassification(input:AssessmentClassification):AssessmentClassification{
  if(!input||!dispositions.includes(input.disposition))throw Error('Invalid assessment policy decision');
  return{disposition:input.disposition,reasons:codes(input.reasons)};
}
function topPaths(change:ResourceChange):string[]{
  return(['id','provider','spec','dependsOn','lifecycle'] as const).filter(key=>canonical(change.previous?.[key])!==canonical(change.desired?.[key])).map(key=>'/'+key);
}
export function projectAssessedChange(change:ResourceChange,input:ChangeProbe,strategy:ChangeAssessmentStrategy):AssessedResourceChange{
  const probe=readChangeProbe(input),classified=readAssessmentClassification(strategy.classify(change,probe));
  return projectAssessedDecision(change,probe,classified,admitChangeDisposition(change,probe,classified.disposition));
}
/** Pure projection after the separately recorded policy and common capability admission. */
export function projectAssessedDecision(change:ResourceChange,input:ChangeProbe,policy:AssessmentClassification,admission:AssessmentClassification):AssessedResourceChange{
  const probe=readChangeProbe(input),classified=readAssessmentClassification(policy),admitted=readAssessmentClassification(admission),disposition=admitted.disposition;
  if(canonical(admitted)!==canonical(admitChangeDisposition(change,probe,classified.disposition)))throw Error('Assessment capability admission changed');
  const reasons=[...new Set([...probe.reasons,...classified.reasons,...admitted.reasons])].sort();
  const requirements=disposition==='replace'?['migration-adapter','fresh-observation','retain-original',
    ...(change.data==='stateless'?['candidate-validation','cutover-approval']:['writer-fence','verified-backup','data-validation','cutover-approval']),
    ...(change.data==='unknown'?['data-classification']:[])]:disposition==='update'||disposition==='create'?['executor-preflight','fresh-observation']
      :disposition==='delete'?['explicit-removal-plan','retention-review']:disposition==='unknown'?['provider-capability-unconfirmed']:disposition==='blocked'?['operator-review']:disposition==='verify'?['readiness-check']:[];
  const {physicalId,revision,...observation}=probe.observation;
  return readAssessedChange({id:change.id,label:change.label,resourceId:(change.desired??change.previous)!.id,provider:(change.desired??change.previous)!.provider,
    adapterId:change.adapterId,strategyId:change.strategyId,data:change.data,previousDigest:change.previous?fingerprint(change.previous):null,
    desiredDigest:change.desired?fingerprint(change.desired):null,changedPaths:probe.changedPaths??topPaths(change),disposition,reasons,validation:probe.validation,
    observed:{...observation,...(physicalId?{identityDigest:fingerprint(physicalId)}:{}),...(revision?{revisionDigest:fingerprint(revision)}:{})},requirements:[...new Set([...requirements,...(probe.requirements??[])])].sort()});
}

import {canonical,fingerprint} from '../util.ts';
import {recordedAssessmentDefinition} from './project.ts';
import {sealChangeAssessmentReport} from './report.ts';
import {consumeAssessment,type AssessmentStages,type ChangeAssessmentScope} from './scope.ts';
export {assessmentScopeFactory,ChangeAssessmentScope,type AssessmentStages} from './scope.ts';
export function initializeAssessment(config:AssessmentStages){return(scope:ChangeAssessmentScope)=>{
  const definition=recordedAssessmentDefinition(config.definition);
  scope.setValue('definition',definition);scope.setValue('definitionDigest',config.state.definitionDigest);scope.setValue('executionId',config.state.executionId);
  for(const change of definition.changes)scope.setValue('change:'+change.id,change);
};}
export function sealAssessment(config:AssessmentStages){return(scope:ChangeAssessmentScope)=>{
  consumeAssessment(scope,config);for(const change of config.definition.changes){const decision=config.state.decisions.find(item=>item.id===change.id);if(canonical(scope.getValue('decision:'+change.id))!==canonical(decision))throw Error('Assessment native decision changed');}
  config.state.report=sealChangeAssessmentReport({kind:'change-assessment',schemaVersion:1,id:config.definition.id,label:config.definition.label,target:{id:config.definition.target.id,scopeDigest:fingerprint(config.definition.target.scope)},
    definitionDigest:config.state.definitionDigest,executionId:config.state.executionId!,assessedAt:Date.now(),changes:config.state.decisions});scope.setValue('report',config.state.report);
};}

import {ScopeFacade,type ScopeFactory} from 'footprintjs/advanced';
import {canonical} from '../util.ts';
import {recordedAssessmentDefinition} from './project.ts';
import type {ChangeAssessmentDefinition,ChangeAssessmentRegistry,ChangeAssessmentState} from './types.ts';

export class ChangeAssessmentScope extends ScopeFacade{}
export const assessmentScopeFactory:ScopeFactory<ChangeAssessmentScope>=(context,name,readOnly,environment)=>new ChangeAssessmentScope(context,name,readOnly,environment);
export interface AssessmentStages {definition:ChangeAssessmentDefinition;state:ChangeAssessmentState;registry:ChangeAssessmentRegistry;persist():Promise<void>}
export function consumeAssessment(scope:ChangeAssessmentScope,config:AssessmentStages){
  consumeFact(scope,'definition',recordedAssessmentDefinition(config.definition));
  consumeFact(scope,'definitionDigest',config.state.definitionDigest);consumeFact(scope,'executionId',config.state.executionId);
}
/** Read through the tracked scope and bind the public projection to its private host measurement. */
export function consumeFact<T>(scope:ChangeAssessmentScope,key:string,expected:T):T{
  const observed=scope.getValue(key);
  if(canonical(observed)!==canonical(expected))throw Error('Assessment native fact binding changed');
  return observed as T;
}

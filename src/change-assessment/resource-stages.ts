import {fingerprint} from '../util.ts';
import {readChangeProbe} from './data.ts';
import {recordedCapability,recordedObservation} from './facts.ts';
import {projectAssessedDecision,readAssessmentClassification,recordedAssessmentDefinition,type AssessmentClassification} from './project.ts';
import {consumeAssessment,consumeFact,type AssessmentStages,type ChangeAssessmentScope} from './scope.ts';
import {admitChangeDisposition} from './strategy.ts';
import {CHANGE_ASSESSMENT_EVENT,type ChangeProbe,type ResourceChange} from './types.ts';

/** One provider call; its sanitized facts, pure policy and common guard have separate native writers. */
export function resourceAssessmentStages(config:AssessmentStages,change:ResourceChange){
  let probe:ChangeProbe|undefined,policy:AssessmentClassification|undefined,admission:AssessmentClassification|undefined;
  const measured=()=>{if(!probe)throw Error('Read-only assessment observation is missing');return probe;};
  const chosen=()=>{if(!policy)throw Error('Assessment policy choice is missing');return policy;};
  const admitted=()=>{if(!admission)throw Error('Assessment capability admission is missing');return admission;};
  const consume=(scope:ChangeAssessmentScope)=>{
    consumeAssessment(scope,config);
    consumeFact(scope,'change:'+change.id,recordedAssessmentDefinition(config.definition).changes.find(item=>item.id===change.id)!);
  };
  const observations=(scope:ChangeAssessmentScope)=>consumeFact(scope,'observation:'+change.id,recordedObservation(measured()));
  const capability=(scope:ChangeAssessmentScope)=>consumeFact(scope,'capability:'+change.id,recordedCapability(measured()));
  const classification=(scope:ChangeAssessmentScope)=>consumeFact(scope,'classification:'+change.id,{strategyId:change.strategyId,...chosen()});
  const progress=async(scope:ChangeAssessmentScope,status:'checking'|'checked')=>{
    scope.emitEvent(CHANGE_ASSESSMENT_EVENT,{executionId:config.state.executionId,changeId:change.id,status});await config.persist();
  };
  return{
    async observe(scope:ChangeAssessmentScope){
      consume(scope);await progress(scope,'checking');
      try{probe=readChangeProbe(await config.registry.adapters.find(adapter=>adapter.id===change.adapterId)!.probe(change,{executionId:config.state.executionId!,
        operationId:fingerprint({executionId:config.state.executionId,changeId:change.id}),definitionDigest:config.state.definitionDigest,target:config.definition.target}));}
      catch{probe=readChangeProbe({observation:{exists:false},update:'unknown',validation:'not-checked',reasons:['provider-observation-unavailable']});}
      scope.setValue('observation:'+change.id,recordedObservation(probe));
    },
    capability(scope:ChangeAssessmentScope){
      consume(scope);observations(scope);scope.setValue('capability:'+change.id,recordedCapability(measured()));
    },
    classify(scope:ChangeAssessmentScope){
      consume(scope);observations(scope);capability(scope);
      const strategy=config.registry.strategies.find(strategy=>strategy.id===change.strategyId)!;
      // An unavailable observation is not absence, even when a custom policy asks to create.
      try{policy=readAssessmentClassification(measured().reasons.includes('provider-observation-unavailable')
        ?{disposition:'unknown',reasons:['provider-observation-unavailable']}:strategy.classify(change,measured()));}
      catch{throw Error('Assessment policy could not classify the recorded facts');}
      scope.setValue('classification:'+change.id,{strategyId:change.strategyId,...policy});
    },
    admit(scope:ChangeAssessmentScope){
      consume(scope);observations(scope);capability(scope);const selected=classification(scope);
      admission=admitChangeDisposition(change,measured(),selected.disposition);
      scope.setValue('admission:'+change.id,admission);
    },
    async record(scope:ChangeAssessmentScope){
      consume(scope);observations(scope);capability(scope);classification(scope);
      const allowed=consumeFact(scope,'admission:'+change.id,admitted());
      const decision=projectAssessedDecision(change,measured(),chosen(),allowed);
      config.state.decisions.push(decision);scope.setValue('decision:'+change.id,decision);await progress(scope,'checked');
    },
  };
}

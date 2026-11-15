import {flowChart} from 'footprintjs';
import {assessmentScopeFactory,ChangeAssessmentScope,initializeAssessment,sealAssessment,type AssessmentStages} from './stages.ts';
import {resourceAssessmentStages} from './resource-stages.ts';

/** Sole construction point for native read-only assessment. It performs no provider work while building. */
export function createChangeAssessmentChart(config:AssessmentStages){
  const chart=flowChart<void,ChangeAssessmentScope>('Review requested changes',initializeAssessment(config),'admit').setScopeFactory(assessmentScopeFactory);
  config.definition.changes.forEach((change,index)=>{
    const stages=resourceAssessmentStages(config,change);
    chart.addFunction('Observe '+change.label,stages.observe,'observe-'+index)
      .addFunction('Inspect update capability',stages.capability,'capability-'+index)
      .addFunction('Choose change strategy',stages.classify,'classify-'+index)
      .addFunction('Check change safeguards',stages.admit,'admit-'+index)
      .addFunction('Record '+change.label+' decision',stages.record,'decision-'+index);
  });
  return chart.addFunction('Record change assessment',sealAssessment(config),'seal').build();
}

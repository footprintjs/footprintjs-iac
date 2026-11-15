import { flowChart } from 'footprintjs';
import { pipelineScopeFactory,type PipelineScope } from './scope.ts';
import { canRunStage,checkPipelineStage,finishPipelineStage,initializePipelineStage,observePipelineStage,rolloutActionStage,skipPipelineStep,type PipelineStages } from './stages.ts';

/** The chart runs the admitted plan itself; runtime branches retain skipped-step decisions. */
export function createPipelineStageChart(config:PipelineStages){
  const chart=flowChart<void,PipelineScope>('Stage admission',initializePipelineStage(config),'admission').setScopeFactory(pipelineScopeFactory);
  for(const [index,step] of config.plan.steps.entries()){
    chart.addDeciderFunction('Run '+step.id+'?',canRunStage(config,'run-'+index,'skip-'+index),'route-'+index)
      .addFunctionBranch('run-'+index,step.kind==='action'?step.operation:'Measure canary',step.kind==='action'?rolloutActionStage(config,step):checkPipelineStage(config,step.id,'rollout-analysis'))
      .addFunctionBranch('skip-'+index,'Retain skipped step',skipPipelineStep(config,step.id)).end();
  }
  return chart.addDeciderFunction('Acceptance checks?',canRunStage(config,'acceptance','skip-acceptance'),'route-acceptance')
    .addFunctionBranch('acceptance','Check application',checkPipelineStage(config,'acceptance','after-deploy'))
    .addFunctionBranch('skip-acceptance','Retain skipped checks',skipPipelineStep(config,'acceptance')).end()
    .addFunction('Observe deployed release',observePipelineStage(config),'observe')
    .addFunction('Record stage outcome',finishPipelineStage(config),'outcome').build();
}

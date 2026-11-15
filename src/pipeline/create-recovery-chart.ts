import { flowChart } from 'footprintjs';
import { pipelineScopeFactory,type PipelineScope } from './scope.ts';
import { canRunStage,checkPipelineStage,finishPipelineStage,initializePipelineStage,observePipelineStage,rolloutActionStage,skipPipelineStep,type PipelineStages } from './stages.ts';

/** Recovery is a separate finite recorded attempt linked to its failed rollout receipt. */
export function createPipelineRecoveryChart(config:PipelineStages){
  return flowChart<void,PipelineScope>('Recovery admission',initializePipelineStage(config),'recovery-admission').setScopeFactory(pipelineScopeFactory)
    .addDeciderFunction('Can restore verified release?',canRunStage(config,'restore','skip-restore'),'route-restore')
    .addFunctionBranch('restore','Restore verified release',rolloutActionStage(config,{kind:'action',id:'restore',operation:'restore'}))
    .addFunctionBranch('skip-restore','Retain blocked restoration',skipPipelineStep(config,'restore')).end()
    .addDeciderFunction('Can verify recovery?',canRunStage(config,'recovery-checks','skip-recovery-checks'),'route-recovery-checks')
    .addFunctionBranch('recovery-checks','Check recovered application',checkPipelineStage(config,'acceptance','recovery'))
    .addFunctionBranch('skip-recovery-checks','Retain blocked checks',skipPipelineStep(config,'recovery-checks')).end()
    .addFunction('Observe recovered release',observePipelineStage(config),'recovery-observe')
    .addFunction('Record recovery outcome',finishPipelineStage(config),'recovery-outcome').build();
}

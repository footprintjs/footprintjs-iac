import { ScopeFacade,type ScopeFactory } from 'footprintjs/advanced';
export class PipelineScope extends ScopeFacade {}
export const pipelineScopeFactory:ScopeFactory<PipelineScope>=(context,name,readOnly,environment)=>new PipelineScope(context,name,readOnly,environment);
export type PipelineStageFunction=(scope:PipelineScope)=>Promise<void>;

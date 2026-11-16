import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {FlowChartExecutor,type CombinedRecorder} from 'footprintjs';
import {fileSink} from 'footprintjs/sinks';
import {controlDepRecorder} from 'footprintjs/trace';
import type {DeliveryRecording} from '../delivery/types.ts';
import type {createPreparationChart} from './create-preparation-chart.ts';

interface NativePreparationOptions {
 chart:ReturnType<typeof createPreparationChart>;
 directory:string;stack:string;definitionDigest:string;executionId:string;
 evidenceKind:string;controlId:string;progress:CombinedRecorder;recorders?:readonly CombinedRecorder[];
 limitations?:readonly string[];
 complete():boolean;failed():boolean;onComplete?():void;
 writeJson(path:string,value:unknown):Promise<void>;
}
interface NativePreparationOutcome {started:boolean;status:'passed'|'failed'|'incomplete';recording?:DeliveryRecording}

/** One native executor/capture lifecycle; wrappers retain their public output policies. */
export async function runNativePreparation(options:NativePreparationOptions):Promise<NativePreparationOutcome>{
 const id=randomUUID(),evidencePath=join(options.directory,id+'.json'),tracePath=join(options.directory,id+'.jsonl');
 const control=controlDepRecorder({id:options.controlId});
 let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,executionFailed=false,captureFailed=false;
 try{
  sink=fileSink(tracePath);executor=new FlowChartExecutor(options.chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});
  executor.enableNarrative();executor.attachCombinedRecorder(options.progress);executor.attachCombinedRecorder(control);
  for(const recorder of options.recorders??[])executor.attachCombinedRecorder(recorder);await executor.run();
 }catch{executionFailed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
 if(!executor)return{started:false,status:'incomplete'};
 const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};
 for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const entry=control.asLookup()(commit.runtimeStageId);if(entry)controlDeps[commit.runtimeStageId]=entry;}
 captureFailed||=(snapshot.sink?.failed??0)>0;
 const complete=options.complete(),recordedFailure=options.failed();
 if(!executionFailed&&complete)try{options.onComplete?.();}catch{captureFailed=true;}
 const status=captureFailed||(executionFailed||!complete)&&!recordedFailure?'incomplete':recordedFailure?'failed':'passed';
 try{
  await options.writeJson(evidencePath,{version:1,kind:options.evidenceKind,runId:snapshot.runId,stack:options.stack,
   executionId:options.executionId,definitionDigest:options.definitionDigest,snapshot,structure:options.chart.buildTimeStructure,
   controlDeps,decisions:control.getDecisions(),narrative:executor.getNarrativeEntries(),tracePath,
   traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},status,...options.limitations?{limitations:options.limitations}:{}});
 }catch{captureFailed=true;}
 const retainedStatus=captureFailed?'incomplete':status;
 return{started:true,status:retainedStatus,recording:{runId:snapshot.runId!,evidencePath,tracePath,status:retainedStatus}};
}

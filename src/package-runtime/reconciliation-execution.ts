import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {FlowChartExecutor,type CombinedRecorder} from 'footprintjs';
import {fileSink} from 'footprintjs/sinks';
import {controlDepRecorder} from 'footprintjs/trace';
import {fingerprint} from '../util.ts';
import {createPackageReconciliationChart} from './create-package-reconciliation-chart.ts';
import {createPackageSettlementChart} from './create-package-settlement-chart.ts';
import {packageReconciliationBinding,packageReconciliationRelatedEvidence} from './reconciliation-recording.ts';
import type {PackageReconciliationConfiguration} from './reconciliation-stages.ts';
import type {PackageActivationStore} from './store.ts';
import type {PackageNativeRecording} from './types.ts';
export async function executePackageReconciliationLeg(config:PackageReconciliationConfiguration,store:PackageActivationStore,phase:'observation'|'settlement',recorders:readonly CombinedRecorder[]){
 const id=randomUUID(),evidencePath=join(store.directory,id+'.json'),tracePath=join(store.directory,id+'.jsonl'),chart=phase==='observation'?createPackageReconciliationChart(config):createPackageSettlementChart(config);
 const control=controlDepRecorder({id:'iac-package-reconciliation-control'});let sink:ReturnType<typeof fileSink>|undefined,executor:FlowChartExecutor|undefined,failed=false,captureFailed=false;
 try{sink=fileSink(tracePath);executor=new FlowChartExecutor(chart,{readTracking:'full',writeProvenance:'reads-prefix',sink:{adapter:sink,onFailure:'fail',flush:'auto'}});executor.enableNarrative();executor.attachCombinedRecorder(control);for(const recorder of recorders)executor.attachCombinedRecorder(recorder);await executor.run();}catch{failed=true;}finally{if(sink)try{await sink.close();}catch{captureFailed=true;}}
 const absent:PackageNativeRecording={runId:'unobserved-'+id,evidencePath,tracePath,digest:fingerprint({id,phase}),complete:false};if(!executor)return{proof:absent,outcome:'incomplete' as const};
 const snapshot=executor.getSnapshot(),controlDeps:Record<string,unknown>={};for(const commit of snapshot.commitLog)if(commit.runtimeStageId){const value=control.asLookup()(commit.runtimeStageId);if(value)controlDeps[commit.runtimeStageId]=value;}
 captureFailed||=(snapshot.sink?.failed??0)>0;const outcome: 'ready'|'verification-failed'|'incomplete'=!failed&&!captureFailed&&['ready','verification-failed'].includes(String(snapshot.sharedState.outcome))?snapshot.sharedState.outcome as 'ready'|'verification-failed':'incomplete';
 const binding={...packageReconciliationBinding(config.state,config.segment),...(phase==='settlement'?{inspectionRunId:config.segment.observationRecording.runId,inspectionRecordingDigest:config.segment.observationRecording.digest}:{})};
 const relatedEvidence=packageReconciliationRelatedEvidence(config.state,config.segment,phase==='settlement');
 const evidence=JSON.parse(JSON.stringify({version:1,kind:'package-reconciliation-'+phase,stack:config.state.definition.id,runId:snapshot.runId,...binding,originalEvidencePath:config.state.recording!.evidencePath,originalTracePath:config.state.recording!.tracePath,...(phase==='settlement'?{inspectionEvidencePath:config.segment.observationRecording.evidencePath,inspectionTracePath:config.segment.observationRecording.tracePath}:{}),relatedEvidence,status:outcome,snapshot,structure:chart.buildTimeStructure,controlDeps,decisions:control.getDecisions(),narrative:executor.getNarrativeEntries(),tracePath,traceStatus:{entries:snapshot.sink?.entries??0,failed:(snapshot.sink?.failed??0)+(captureFailed?1:0),flushed:!captureFailed},limitations:['Reconciliation observes the acknowledged prior activation. It does not install files, switch packages, restart services or restore data.']}));
 try{await store.write(evidencePath,evidence);return{proof:{runId:snapshot.runId!,evidencePath,tracePath,digest:fingerprint(evidence),complete:!captureFailed},outcome};}catch{return{proof:{...absent,runId:snapshot.runId!},outcome:'incomplete' as const};}
}

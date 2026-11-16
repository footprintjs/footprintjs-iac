import {randomUUID} from 'node:crypto';
import type {CombinedRecorder} from 'footprintjs';
import {admitPackageActivationRecording} from './recording.ts';
import {admitPackageReconciliationObservation,admitPackageReconciliationChain} from './reconciliation-recording.ts';
import {executePackageReconciliationLeg} from './reconciliation-execution.ts';
import type {PackageActivationStore} from './store.ts';
import type {PackageActivationState,PackageReconciliationSegment,PackageReleaseTarget,PackageRuntimePort} from './types.ts';
export async function reconcilePackageActivation(options:{state:PackageActivationState;store:PackageActivationStore;target:PackageReleaseTarget;runtime:PackageRuntimePort;configurationDigest:string;recorders:readonly CombinedRecorder[];publish(state:PackageActivationState):void}){
 const {store,target,runtime}=options,state=structuredClone(options.state);
 if(state.status==='ready'||state.status==='verification-failed'&&state.reconciliations?.length)return state;
 if(!['incomplete','verification-failed'].includes(state.status)||!state.recording?.complete||!state.receipt||state.reconciliationIntent||(state.reconciliations?.length??0)>=32)throw Error('package-reconciliation-provider-proof-required');
 const original=await admitPackageActivationRecording(state,store.directory),value=original as unknown as {status?:string};
 if(!['incomplete','verification-failed'].includes(value.status??'')||original.snapshot.sharedState.runtimeActivated!==true||value.status==='verification-failed'&&(original.snapshot.sharedState.outcome!=='verification-failed'||!state.observation?.evidence.complete))throw Error('package-reconciliation-original-activation-not-acknowledged');
 state.reconciliationBase??={status:value.status as 'incomplete'|'verification-failed',...state.observation?{observation:structuredClone(state.observation)}:{}};
 const previous=state.reconciliations?.at(-1)?.recording.digest??null,id=randomUUID();
 state.reconciliationIntent={id,phase:'observe'};state.status='incomplete';await store.save(state);options.publish(state);
 const segment={id,configurationDigest:options.configurationDigest,originalRunId:state.recording.runId,originalRecordingDigest:state.recording.digest,previousRecordingDigest:previous,status:'incomplete'} as PackageReconciliationSegment;
 const config={state,segment,target,runtime,persist:async()=>{await store.save(state);options.publish(state);}};
 const observation=await executePackageReconciliationLeg(config,store,'observation',options.recorders);segment.observationRecording=observation.proof;segment.recording=observation.proof;
 if(observation.proof.complete){await admitPackageReconciliationObservation(state,segment,store.directory);if(segment.observation)state.observation=structuredClone(segment.observation);}
 state.reconciliations??=[];state.reconciliations.push(segment);
 if(observation.proof.complete&&observation.outcome!=='incomplete'){
  state.reconciliationIntent.phase='settle';await store.save(state);
  const settled=await executePackageReconciliationLeg(config,store,'settlement',options.recorders);segment.settlementRecording=settled.proof;segment.recording=settled.proof;
  segment.status=settled.proof.complete?settled.outcome:'incomplete';state.status=segment.status;
  if(state.status!=='incomplete')delete state.reconciliationIntent;
 }else if(observation.proof.complete)delete state.reconciliationIntent;
 if(state.status==='incomplete')state.error='The owned activation remains unconfirmed; inspect its retained reconciliation evidence.';else delete state.error;
 await admitPackageReconciliationChain(state,store.directory);await store.save(state);options.publish(state);return state;
}

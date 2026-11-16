import {canonical} from '../util.ts';
import {readPackageRuntimeObservation,readPackageTarget} from './data.ts';
import {packageReconciliationSettlementProof} from './recording.ts';
import {packageReconciliationBinding} from './reconciliation-recording.ts';
import type {PackageScope} from './scope.ts';
import type {PackageActivationState,PackageReconciliationSegment,PackageReleaseTarget,PackageRuntimePort} from './types.ts';
export interface PackageReconciliationConfiguration {state:PackageActivationState;segment:PackageReconciliationSegment;target:PackageReleaseTarget;runtime:PackageRuntimePort;persist():Promise<void>}
export const packageReconciliationStage=(id:string,work:(scope:PackageScope)=>Promise<void>)=>async(scope:PackageScope)=>{try{await work(scope);}catch{scope.setValue('failure',{stageId:id,code:'package-reconciliation-not-confirmed'});throw Error('The registered package reconciliation stage did not confirm its outcome.');}};
const context=(c:PackageReconciliationConfiguration)=>({operationId:c.state.operationId!,packageDigest:c.state.definition.packageDigest,targetId:c.state.definition.targetId});
export const inspectPackageReconciliation=(c:PackageReconciliationConfiguration)=>async(scope:PackageScope)=>{
 scope.setValue('binding',packageReconciliationBinding(c.state,c.segment));scope.setValue('receipt',c.state.receipt);scope.setValue('inspectionIntent',context(c));await c.persist();
 const receipt=scope.getValue('receipt') as NonNullable<PackageActivationState['receipt']>;
 const observed=readPackageTarget(await c.target.inspect());c.segment.target=observed;scope.setValue('target',observed);
 const target=readPackageTarget(scope.getValue('target'));
 const expectedPending=c.state.reconciliationBase?.status==='verification-failed'?null:receipt.operationId;
 if(target.id!==c.state.definition.targetId||target.identityDigest!==receipt.identityDigest||target.currentDigest!==receipt.packageDigest||target.pendingOperationId!==expectedPending)throw Error('package-reconciliation-target-differs');
};
export const observePackageReconciliation=(c:PackageReconciliationConfiguration)=>async(scope:PackageScope)=>{
 if(canonical(scope.getValue('target'))!==canonical(c.segment.target))throw Error('package-reconciliation-target-differs');
 scope.setValue('observationIntent',context(c));await c.persist();
 const observation=readPackageRuntimeObservation(await c.runtime.observe(context(c)));c.segment.observation=observation;scope.setValue('observation',observation);
};
export const classifyPackageReconciliation=(c:PackageReconciliationConfiguration)=>async(scope:PackageScope)=>{
 const observation=readPackageRuntimeObservation(scope.getValue('observation')),receipt=scope.getValue('receipt') as NonNullable<PackageActivationState['receipt']>;
 scope.setValue('outcome',!observation.evidence.complete?'incomplete':observation.ready&&observation.packageDigest===receipt.packageDigest?'ready':'verification-failed');
};
export const settlePackageReconciliation=(c:PackageReconciliationConfiguration)=>async(scope:PackageScope)=>{
 const observed=c.segment.observation;
 const outcome=observed?.evidence.complete?(observed.ready&&observed.packageDigest===c.state.definition.packageDigest?'ready':'verification-failed'):'incomplete';
 const inspection={runId:c.segment.observationRecording.runId,digest:c.segment.observationRecording.digest,outcome};
 const binding={...packageReconciliationBinding(c.state,c.segment),inspectionRunId:inspection.runId,inspectionRecordingDigest:inspection.digest};
 scope.setValue('binding',binding);scope.setValue('receipt',c.state.receipt);scope.setValue('inspection',inspection);scope.setValue('settlementIntent',context(c));await c.persist();
 const measured=scope.getValue('inspection') as typeof inspection,receipt=scope.getValue('receipt') as NonNullable<PackageActivationState['receipt']>;
 if(!['ready','verification-failed'].includes(measured.outcome)||canonical(receipt)!==canonical(c.state.receipt))throw Error('package-reconciliation-measurement-not-complete');
 const previous=c.state.reconciliationBase?.status==='verification-failed'?{runId:c.state.recording!.runId,digest:c.state.recording!.digest,outcome:'verification-failed' as const}:undefined;
 await c.target.settle(receipt,packageReconciliationSettlementProof({runId:measured.runId,digest:measured.digest},measured.outcome as 'ready'|'verification-failed',previous),context(c));
 scope.setValue('settlement',{acknowledged:true,operationId:receipt.operationId,packageDigest:receipt.packageDigest});scope.getValue('settlement');scope.setValue('outcome',measured.outcome);
};

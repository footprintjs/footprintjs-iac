import type {HostProcessRunner} from '../platform-access/types.ts';

export interface DirectoryPackageFile {path:string;digest:string;bytes:number;mode:420|493}
export interface DirectoryPackageManifest {version:1;kind:'directory-package';id:string;files:readonly DirectoryPackageFile[];digest:string}
/** Private content port. File bytes and source paths never enter native recordings. */
export interface DirectoryPackageSource {manifest:DirectoryPackageManifest;read(path:string):Promise<Uint8Array>}
export interface PackageTargetObservation {id:string;exists:boolean;identityDigest:string|null;currentDigest:string|null;previousDigest:string|null;pendingOperationId:string|null}
export interface PackageOperationContext {operationId:string;packageDigest:string;targetId:string}
export interface PackageActivationReceipt {operationId:string;packageDigest:string;previousDigest:string|null;identityDigest:string}
export interface PackageRuntimeObservation {runtimeId:string;packageDigest:string|null;ready:boolean;evidence:{method:'process-files'|'immutable-image';digest:string;complete:boolean}}
export interface PackageRuntimePort {activate(context:PackageOperationContext):Promise<void>;observe(context:PackageOperationContext):Promise<PackageRuntimeObservation>}
export interface PackageReleaseTarget {
 readonly id:string;
 inspect():Promise<PackageTargetObservation>;
 stage(source:DirectoryPackageSource,before:PackageTargetObservation,context:PackageOperationContext):Promise<PackageTargetObservation>;
 activate(before:PackageTargetObservation,context:PackageOperationContext):Promise<PackageActivationReceipt>;
 settle(receipt:PackageActivationReceipt,proof:{runId:string;digest:string;outcome:'ready'|'verification-failed';previousSettlement?:{runId:string;digest:string;outcome:'verification-failed'}},context:PackageOperationContext):Promise<void>;
}
export interface FileReleaseTargetOptions {id:string;directory:string;runner?:HostProcessRunner;sudo?:boolean;allowRuntimeTraversal?:boolean}
export const PACKAGE_STAGE_IDS=['verify','stage','activate','observe'] as const;
export type PackageStageId=typeof PACKAGE_STAGE_IDS[number];
export interface PackageActivationDefinition {id:string;targetId:string;packageId:string;packageDigest:string;configurationDigest:string}
export interface PackageNativeRecording {runId:string;evidencePath:string;tracePath:string;digest:string;complete:boolean}
export interface PackageReconciliationSegment {
 id:string;configurationDigest:string;originalRunId:string;originalRecordingDigest:string;previousRecordingDigest:string|null;
 status:'ready'|'verification-failed'|'incomplete';target?:PackageTargetObservation;observation?:PackageRuntimeObservation;
 observationRecording:PackageNativeRecording;settlementRecording?:PackageNativeRecording;recording:PackageNativeRecording;
}
export interface PackageActivationState {
 version:1;kind:'package-activation-state';definition:PackageActivationDefinition;definitionDigest:string;operationId:string|null;
 status:'idle'|'running'|'ready'|'verification-failed'|'failed'|'incomplete';
 stages:{id:PackageStageId;label:string;status:'pending'|'running'|'passed'|'failed'}[];
 events:{sequence:number;stageId:PackageStageId;status:'running'|'passed'|'failed';runtimeStageId:string;timestamp:number}[];
 before?:PackageTargetObservation;staged?:PackageTargetObservation;receipt?:PackageActivationReceipt;observation?:PackageRuntimeObservation;
 recording?:PackageNativeRecording;
 reconciliationBase?:{status?:'incomplete'|'verification-failed';observation?:PackageRuntimeObservation};
 reconciliationIntent?:{id:string;phase:'observe'|'settle'};
 reconciliations?:PackageReconciliationSegment[];
 error?:string;
}

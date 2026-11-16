import type { AdapterFlowOutcome } from '../adapter-flow/types.ts';
import type { Observation, PlannedOperation } from '../types.ts';
import { fingerprint } from '../util.ts';
import type { OperationExecutionOptions } from './execute-operation.ts';
import { PersistenceError } from './persistence.ts';
import type { ExecutionScope } from './scope.ts';
import type { OperationResult } from './types.ts';

/** Private provider facts/errors never become arbitrary scope or event payloads. */
export class NativeOperation {
  readonly adapter;
  readonly context;
  private observed: Observation | undefined;
  private error: unknown;
  private attempt = 0;
  private needsEffect = false;
  private reviewedDrift = false;
  private result: OperationResult | undefined;
  readonly operation: PlannedOperation;
  private readonly options: OperationExecutionOptions;
  constructor(operation: PlannedOperation, options: OperationExecutionOptions) {
    this.operation=operation;this.options=options;
    this.adapter = options.adapters.get(operation.resource.provider)!;
    this.context = { stack: options.state.stack, operationId: operation.operationId };
  }
  private append(event:'begin'|'observed'|'complete'|'failed', detail?:string) {
    return this.options.persistence.append({event,runId:this.options.runId,stack:this.options.state.stack,
      operationId:this.operation.operationId,resourceId:this.operation.resource.id,action:this.operation.action,
      at:new Date().toISOString(),...(detail?{detail}:{})});
  }
  private async guarded(scope:ExecutionScope, work:()=>Promise<void>) {
    if(this.error)return;
    try { await work(); }
    catch(error) { if(error instanceof PersistenceError)throw error;this.error=error; }
    scope.setValue('nativeHasError',!!this.error);
  }
  async begin(scope:ExecutionScope) {
    // Native input reads connect the parent desired state/dependencies to this lifecycle.
    if(fingerprint(scope.getValue('desiredSpec'))!==this.operation.desiredFingerprint)throw Error('Native operation input mismatch');
    void scope.getValue('dependencyResults');void scope.getValue('planAction');
    await this.append('begin');
  }
  async inspect(scope:ExecutionScope) {
    this.attempt++;this.error=undefined;this.needsEffect=false;this.reviewedDrift=false;
    scope.setValue('nativeRetry',false);scope.setValue('nativeHasError',false);
    await this.guarded(scope,async()=>{
      this.observed=await this.adapter.observe(this.operation.resource,this.context);
      scope.setValue('nativeObservation',this.observed);
      await this.append('observed',JSON.stringify(this.observed));
      if(this.observed.exists&&this.observed.owned!==true)throw Error('Native resource is not owned');
    });
  }
  async intent(scope:ExecutionScope) {
    await this.guarded(scope,async()=>{
      void scope.getValue('nativeObservation');
      const {state,persistence}=this.options,operation=this.operation,observed=this.observed!;
      const old=state.resources[operation.resource.id];
      const recovered=old?.pending?.action==='create'&&old.pending.operationId===operation.operationId&&old.pending.desiredFingerprint===operation.desiredFingerprint;
      this.needsEffect=!observed.exists||observed.fingerprint!==operation.desiredFingerprint||!!(old&&old.fingerprint!==operation.desiredFingerprint&&!recovered);
      if(this.options.reviewedPlan&&['noop','verify'].includes(operation.action)&&this.needsEffect){this.reviewedDrift=true;throw Error('A reviewed check now needs a mutation; review again');}
      if(this.needsEffect){
        state.resources[operation.resource.id]={resource:old?.resource??operation.resource,fingerprint:old?.fingerprint??'',
          pending:{operationId:operation.operationId,action:observed.exists?'update':'create',desiredFingerprint:operation.desiredFingerprint}};
        await persistence.save(state);
      }
      scope.setValue('nativeIntent',this.needsEffect?{operationId:operation.operationId,desiredFingerprint:operation.desiredFingerprint}:null);
    });
    scope.setValue('nativeNeedsEffect',this.needsEffect&&!this.error);
  }
  acceptEffect(scope:ExecutionScope) {
    const outcome=scope.getValue('adapterFlowOutcome') as AdapterFlowOutcome|undefined;
    if(this.needsEffect&&!this.error&&outcome?.status!=='passed')this.error=Error('adapter-effect-unconfirmed');
    scope.setValue('nativeHasError',!!this.error);
  }
  async verify(scope:ExecutionScope) {
    await this.guarded(scope,async()=>{
      void scope.getValue('adapterFlowOutcome');void scope.getValue('nativeIntent');
      await this.adapter.waitReady(this.operation.resource,this.context);
      this.observed=await this.adapter.observe(this.operation.resource,this.context);
      scope.setValue('nativeVerifiedObservation',this.observed);
      if(!this.observed.exists||this.observed.owned!==true||this.observed.fingerprint!==fingerprint(this.operation.resource.spec))throw Error('Native provider did not converge');
    });
  }
  acceptVerification(scope:ExecutionScope){
    if(!this.error&&(scope.getValue('verificationFlowOutcome') as AdapterFlowOutcome|undefined)?.status!=='passed')this.error=Error('adapter-verification-unconfirmed');
    scope.setValue('nativeHasError',!!this.error);
  }
  checkpoint(scope:ExecutionScope){return this.guarded(scope,()=>this.complete(false));}
  private async complete(reconciled:boolean) {
    const {operation,options}=this,observed=this.observed!;
    options.state.resources[operation.resource.id]={resource:operation.resource,fingerprint:operation.desiredFingerprint,...(observed.physicalId?{physicalId:observed.physicalId}:{})};
    await options.persistence.save(options.state);
    await this.append('complete',reconciled?'Reconciled after an uncertain native effect':undefined);
    this.result={status:'complete',action:operation.action,attempts:this.attempt,physicalId:observed.physicalId??null,...(reconciled?{reconciled:true}:{})};
  }
  async recover(scope:ExecutionScope) {
    if(!this.error)return;
    // Persistence/capture failures abort outside this recovery path. No provider retry may hide them.
    const {operation,options}=this;
    let observed:Observation|undefined;
    try{observed=await this.adapter.observe(operation.resource,this.context);}catch{/* Unknown is never absence. */}
    scope.setValue('nativeRecoveryObservation',observed??null);
    const pending=options.state.resources[operation.resource.id]?.pending;
    if(!this.reviewedDrift&&pending?.action==='create'&&pending.operationId===operation.operationId
      &&observed?.exists===true&&observed.owned===true&&observed.fingerprint===operation.desiredFingerprint){
      try{
        await this.adapter.waitReady(operation.resource,this.context);
        this.observed=await this.adapter.observe(operation.resource,this.context);
        if(this.observed.exists&&this.observed.owned===true&&this.observed.fingerprint===operation.desiredFingerprint){await this.complete(true);this.error=undefined;scope.setValue('nativeHasError',false);return;}
      }catch(error){if(error instanceof PersistenceError)throw error;}
    }
    const decision=options.strategy.decide(this.error,observed,this.attempt);
    const retry=!this.reviewedDrift&&this.adapter.supportsSafeRetry===true&&decision.retry&&this.attempt<options.strategy.maxAttempts;
    // Strategy text and provider exception messages are not public telemetry.
    await this.append('observed',retry?'Native effect requires a safe retry':'Native effect remains unconfirmed');
    scope.setValue('nativeRetry',retry);
  }
  async finish(scope:ExecutionScope):Promise<OperationResult> {
    void scope.getValue('nativeVerifiedObservation');void scope.getValue('nativeRecoveryObservation');
    if(this.result)return this.result;
    await this.append('failed','native-operation-unconfirmed');
    return {status:'failed',message:this.reviewedDrift?'A reviewed check now needs a mutation; inspect the changed resource and review again':'native-operation-unconfirmed'};
  }
}

import { randomUUID } from 'node:crypto';
import { loadEvidence } from '../evidence.ts';
import { verifyEvidenceTrace } from '../evidence-trace.ts';
import { assertExecutableGraph } from '../graph/validation.ts';
import type { InfraGraph } from '../graph/types.ts';
import { verifyRevisionOutcome } from '../master/evidence.ts';
import { fingerprintPlan } from '../master/plan.ts';
import { canonical, fingerprint } from '../util.ts';
import type { ApplyResult } from '../engine.ts';
import type { ResourceAdapter, Stack, StateStore } from '../types.ts';
import { createReconciliationChart } from './create-reconciliation-chart.ts';
import { runApplyChart } from './run-apply-chart.ts';
import { providerContext } from './provider-state.ts';

export interface EngineReconciliationResult {
  originalRunId:string; status:'failed'|'unknown'; runId:string; evidencePath:string; tracePath:string; digest:string;
}

/** Read-only native proof admission is also used when reopening a controller. */
export async function admitEngineReconciliation(result:EngineReconciliationResult,original:ApplyResult):Promise<void>{
  const evidence=await loadEvidence(result.evidencePath),record=evidence as unknown as Record<string,unknown>;
  if(record.kind!=='operation-reconciliation'||evidence.runId!==result.runId||record.nativeRunId!==evidence.snapshot.runId
    ||evidence.tracePath!==result.tracePath||fingerprint(evidence)!==result.digest||record.originalRunId!==original.runId
    ||record.originalEvidenceDigest!==fingerprint(await loadEvidence(original.evidencePath))
    ||record.originalPlanDigest!==fingerprintPlan(original.plan)||record.status!==result.status
    ||evidence.snapshot.sharedState.outcome!==result.status||evidence.snapshot.sharedState.originalRunId!==original.runId||result.originalRunId!==original.runId)throw Error('native-operation-reconciliation-not-admitted');
  await verifyEvidenceTrace(evidence);
  const ids=evidence.snapshot.sharedState.operationIds;
  if(!Array.isArray(ids)||ids.length===0||new Set(ids).size!==ids.length||ids.some(id=>!original.plan.operations.some(operation=>operation.operationId===id)))throw Error('native-operation-reconciliation-binding-differs');
  if(result.status==='failed')for(const id of ids){
    const operation=original.plan.operations.find(operation=>operation.operationId===id)!;
    const inspection=evidence.snapshot.sharedState[`inspection:${operation.resource.id}`] as import('../types.ts').ResourceOutcomeInspection|null;
    if(inspection?.runtimeControlReturned!==true||inspection.quiescent!==true||inspection.observation.exists!==true
      ||inspection.observation.owned!==true||inspection.observation.ready!==false)throw Error('native-operation-failure-not-established');
  }
}

export async function reconcileEngine(input:{stack:Stack;original:ApplyResult;store:StateStore;adapters:ReadonlyMap<string,ResourceAdapter>;traceDirectory?:string}):Promise<EngineReconciliationResult>{
  assertExecutableGraph(input.stack);const stack=structuredClone(input.stack),original=structuredClone(input.original);
  if(original.ok||!original.failure||original.plan.stack!==stack.name||(stack as {kind?:string}).kind!=='infra-graph')throw Error('a-complete-failed-native-operation-is-required');
  await verifyRevisionOutcome({graph:stack as InfraGraph},original);await verifyEvidenceTrace(await loadEvidence(original.evidencePath));
  return input.store.withLock(stack.name,async()=>{
    const state=await input.store.load(stack.name);
    const previous=state.reconciliations?.find(row=>row.originalRunId===original.runId);
    if(previous){const result={...previous,status:'failed' as const};await admitEngineReconciliation(result,original);return result;}
    const operations=original.plan.operations.filter(operation=>state.resources[operation.resource.id]?.pending?.operationId===operation.operationId);
    if(!operations.length)throw Error('no-matching-pending-operation-to-reconcile');
    if(Object.values(state.resources).some(managed=>managed.pending&&!operations.some(operation=>operation.operationId===managed.pending!.operationId)))throw Error('another-pending-operation-remains-unknown');
    for(const operation of operations){
      const pending=state.resources[operation.resource.id]!.pending!,adapter=input.adapters.get(operation.resource.provider);
      const inputResolution=operation.inputResolution;
      const spec=pending.resolvedSpec, expected=spec?fingerprint(spec):operation.desiredFingerprint;
      if(!!spec!==!!inputResolution||(spec&&inputResolution&&'spec' in inputResolution&&canonical(spec)!==canonical(inputResolution.spec))
        ||pending.desiredFingerprint!==expected||!adapter?.inspectOutcome||!adapter.scope
        ||state.providerScopes?.[adapter.name]!==adapter.scope)throw Error('pending-operation-inspector-not-registered');
    }
    const pendingBefore=new Map(operations.map(operation=>[operation.resource.id,canonical(state.resources[operation.resource.id]!.pending)]));
    const runId=randomUUID(),chart=createReconciliationChart(original.runId,operations,async operation=>{
      const adapter=input.adapters.get(operation.resource.provider)!;
      const spec=state.resources[operation.resource.id]!.pending!.resolvedSpec??operation.resource.spec;
      return structuredClone(await adapter.inspectOutcome!(structuredClone({...operation.resource,spec}),providerContext(state,operation.resource.id,operation.operationId)));
    });
    if(!input.traceDirectory)throw Error('native-reconciliation-trace-directory-required');
    const recorded=await runApplyChart(chart,runId,input.traceDirectory);
    if(!recorded.tracePath||recorded.traceStatus?.flushed!==true||recorded.traceStatus.failed!==0)throw Error('native-reconciliation-capture-incomplete');
    const status=recorded.snapshot.sharedState.outcome as 'failed'|'unknown';
    const evidence=JSON.parse(JSON.stringify({version:1 as const,kind:'operation-reconciliation',runId,nativeRunId:recorded.snapshot.runId,stack:stack.name,originalRunId:original.runId,
      originalEvidenceDigest:fingerprint(await loadEvidence(original.evidencePath)),originalPlanDigest:fingerprintPlan(original.plan),status,...recorded}));
    const evidencePath=await input.store.saveEvidence(runId,evidence),result={originalRunId:original.runId,status,runId,evidencePath,tracePath:recorded.tracePath,digest:fingerprint(evidence)};
    await admitEngineReconciliation(result,original);
    if(status==='failed'){
      for(const operation of operations){
        const managed=state.resources[operation.resource.id]!;
        if(canonical(managed.pending)!==pendingBefore.get(operation.resource.id))throw Error('pending-operation-changed-during-reconciliation');
        await input.store.append({event:'observed',runId,stack:stack.name,operationId:operation.operationId,resourceId:operation.resource.id,action:operation.action,at:new Date().toISOString(),detail:`Known failed outcome recorded: ${evidencePath}`});
        delete managed.pending; // The resource/fingerprint remain unchanged; this does not promote it.
      }
      (state.reconciliations??=[]).push({originalRunId:original.runId,runId,evidencePath,tracePath:recorded.tracePath,digest:result.digest});
      await input.store.save(state);
    }
    return result;
  });
}

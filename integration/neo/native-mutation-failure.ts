import assert from 'node:assert/strict';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import type { RecordEntry } from 'foottrace/write';
import { loadEvidence, verifyEvidenceTrace } from '../../src/evidence.ts';
import type { ApplyResult } from '../../src/engine.ts';
import type { Resource } from '../../src/types.ts';
import { canonical, fingerprint } from '../../src/util.ts';

/** Inspect the recorded command boundary, never reinterpret a generic transport error as an API receipt. */
export async function readNeoNativeMutationFailure(result:ApplyResult,resource:Resource){
  assert.equal(result.ok,false);assert.equal(result.failure?.resourceId,resource.id);
  const operation=result.plan.operations.find(operation=>operation.resource.id===resource.id);
  assert.ok(operation);assert.equal(operation.action,'update');assert.equal(operation.resource.provider,'kubernetes');
  assert.equal(canonical(operation.resource),canonical(resource));assert.equal(operation.desiredFingerprint,fingerprint(resource.spec));
  const evidence=await loadEvidence(result.evidencePath);
  assert.equal(evidence.runId,result.runId);assert.equal(evidence.stack,result.plan.stack);assert.equal(evidence.tracePath,result.tracePath);
  assert.equal(canonical(evidence.snapshot.sharedState[`desired:${resource.id}`]),canonical(resource.spec));
  assert.equal(evidence.snapshot.sharedState[`plan:${resource.id}`],operation.action);
  const verified=await verifyEvidenceTrace(evidence),file=readRecordFile(evidence.tracePath!),record=readStoredRecord(file.entries);
  assert.equal(record.unread.length,0);assert.ok([...record.logs.values()].every(log=>log.complete&&!log.gaps.length));
  const root=record.root(verified.runId);assert.ok(root);
  const stageId=`execute-${resource.id}`,mounts=root.commitLog.filter(commit=>commit.stageId===stageId).map(commit=>commit.runtimeStageId);
  const boundaries:{runtimeStageId:string;status:'unknown'}[]=[];
  for(const raw of file.entries){
    const entry=raw as RecordEntry; // Every parsed entry was admitted by readStoredRecord above.
    if(entry.kind!=='commit'||entry.bundle.stageId!==`${stageId}/native-effect/kubernetes-mutate`)continue;
    assert.equal(entry.address.logRunId,verified.runId);assert.equal(entry.address.drillPath.length,2);assert.ok(mounts.includes(entry.address.drillPath[0]!));
    const lifecycle=record.log({logRunId:verified.runId,drillPath:entry.address.drillPath.slice(0,1)});assert.ok(lifecycle);
    assert.equal(canonical(stateAt(lifecycle,0).state.desiredSpec),canonical(resource.spec));assert.equal(stateAt(lifecycle,0).state.planAction,operation.action);
    const log=record.log(entry.address);assert.ok(log);const state=stateAt(log,entry.bundle.idx!).state;
    const progress=state.adapterFlowProgress as Record<string,unknown>;
    assert.equal(progress.deploymentRunId,result.runId);assert.equal(progress.resourceId,resource.id);assert.equal(progress.operationId,operation.operationId);
    assert.equal(progress.adapterId,'kubernetes');assert.equal(progress.phase,'apply');assert.equal(progress.status,'unknown');
    assert.equal((state.adapterFlowOutcome as {status?:string})?.status,'unknown');
    boundaries.push({runtimeStageId:entry.bundle.runtimeStageId,status:'unknown'});
  }
  assert.ok(boundaries.length>0,'The native Kubernetes mutation boundary must have run and retained its unconfirmed outcome');
  return {status:'unconfirmed' as const,nativeRunId:verified.runId,boundaries,
    limitation:'The bounded native outcome does not distinguish an API validation rejection from a transport failure.'};
}

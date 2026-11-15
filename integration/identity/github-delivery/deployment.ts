import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeploymentAdapter, DeliveryPlan, DeliveryPublication } from '../../../src/delivery/types.ts';
import { readSystemRevision, type SystemRevision } from '../../../src/master/index.ts';
import type { MasterWorkflow } from '../../../src/master/workflow.ts';
import type { MasterReview } from '../../../src/master/types.ts';
import type {JsonObject} from '../../../src/types.ts';
import { canonical } from '../../../src/util.ts';
import { createIdentityGraph } from '../graph.ts';
import { verifyNeoResourceFlow } from '../resource-flow-verify.ts';
import type { IdentityTarget } from '../target.ts';
import { readNeoDeliveryJson, writeNeoDeliveryJson } from './files.ts';
import { restoreNeoDeliveryForward } from './forward.ts';
import { publishNeoDeliveryTarget } from './publication.ts';
import { assertNeoDeliveryCandidateRevision, neoCandidateDeliveryRevision, neoDeliveryArtifacts, readNeoDeliveryCandidate, sameNeoDeliveryTarget } from './target.ts';
import type { NeoGithubDeliveryOptions, NeoDeliveryObservation } from './types.ts';
import {assessNeoDeployment,admitNeoAssessmentReceipt,assertNeoAssessmentUnchanged,type NeoAssessmentReceipt} from './assessment.ts';

export function neoDeliveryDeploymentAdapter(options: NeoGithubDeliveryOptions, current: IdentityTarget, directory: string,
  master: MasterWorkflow, emit: (event: NeoDeliveryObservation) => void): DeploymentAdapter {
  const expectedRepository = options.source.repository;
  async function candidate(publication: DeliveryPublication) {
    const metadata = publication.metadata;
    if (typeof metadata?.candidatePath !== 'string' || metadata.repository !== expectedRepository
      || typeof metadata.commit !== 'string' || typeof metadata.tree !== 'string') throw Error('Choose a published Neo package');
    const candidate = await readNeoDeliveryCandidate(metadata.candidatePath, current);
    if (candidate.receipt.baseCommit !== metadata.commit || candidate.receipt.sourceTree !== metadata.tree
      || canonical(publication.artifacts) !== canonical(neoDeliveryArtifacts(candidate.target))) throw Error('Published Neo artifacts differ from their source');
    return candidate;
  }
  async function readPlan(plan: DeliveryPlan): Promise<{ revision: SystemRevision; candidatePath: string; canonicalBytes: string;review:MasterReview;assessment:NeoAssessmentReceipt }> {
    if (typeof plan.metadata?.receiptPath !== 'string'
      || plan.metadata.receiptPath !== join(directory, 'plans', plan.id + '.json')) throw Error('Choose the recorded Neo plan');
    const receipt = await readNeoDeliveryJson(plan.metadata.receiptPath) as {
      plan: DeliveryPlan; revision: SystemRevision; candidatePath: string; canonicalBytes: string;review:MasterReview;assessment:NeoAssessmentReceipt;
    };
    if (canonical(receipt.plan) !== canonical(plan)) throw Error('The Neo deployment plan changed');
    return { ...receipt, revision: readSystemRevision(receipt.revision) };
  }
  return {
    async plan(publication) {
      const selected = await candidate(publication);
      const state = await master.getState();
      if (!state.appliedDigest) throw Error('Adopt the recorded current Neo deployment before planning');
      const revision = neoCandidateDeliveryRevision(selected, expectedRepository, state.appliedDigest);
      if (state.candidateDigest && state.candidateDigest !== revision.digest) throw Error('Another Neo candidate is already staged');
      await master.stage(revision, { expectedAppliedDigest: state.appliedDigest });
      const review = await master.preview();
      if (review.candidateDigest !== revision.digest || review.parentDigest !== state.appliedDigest) throw Error('The Neo master candidate changed during plan review');
      if (review.plan.operations.some(operation => !['noop', 'verify'].includes(operation.action)
        && !(operation.resource.id === 'neo-app' && operation.action === 'update'))) {
        throw Error('This application release may update only the existing Neo application');
      }
      const previous=state.revisions.find(item=>item.digest===state.appliedDigest);
      if(!previous)throw Error('Neo preflight requires the applied revision');
      const assessment=await assessNeoDeployment({options,current,directory,reviewId:review.reviewId,previous,revision,review,phase:'plan',emit});
      const receiptPath = join(directory, 'plans', review.reviewId + '.json');
      const plan: DeliveryPlan = { id: review.reviewId, digest: review.planDigest,
        evidence:[{kind:'change-assessment-plan',digest:assessment.report.digest,runId:assessment.recording.runId}],
        changes: review.plan.operations.map(operation => ({ resourceId: operation.resource.id, action: operation.action })),
        metadata: { receiptPath, revisionDigest: revision.digest, graphDigest: revision.graph.digest,
          assessment:assessment as unknown as JsonObject } };
      await writeNeoDeliveryJson(receiptPath, { plan, revision, candidatePath: selected.path,
        canonicalBytes: await readFile(options.targetPath, 'utf8'),review,assessment });
      emit({ kind: 'plan', graph: revision.graph, review, master: await master.getState() });
      return plan;
    },
    async deploy(plan) {
      const receipt = await readPlan(plan);
      const selected = await readNeoDeliveryCandidate(receipt.candidatePath, current);
      assertNeoDeliveryCandidateRevision(selected, receipt.revision);
      if (receipt.revision.source?.repository !== expectedRepository) throw Error('The sealed Neo source repository changed');
      if (!sameNeoDeliveryTarget(JSON.parse(await readFile(options.targetPath, 'utf8')), current)) throw Error('The applied Neo bindings changed after plan');
      const state = await master.getState();
      if (state.review?.reviewId !== plan.id || state.review.planDigest !== plan.digest
        || state.candidateDigest !== receipt.revision.digest) throw Error('The sealed Neo master review changed');
      const previous=state.revisions.find(item=>item.digest===state.appliedDigest);
      if(!previous||canonical(state.review)!==canonical(receipt.review)||canonical(plan.metadata?.assessment)!==canonical(receipt.assessment))throw Error('The sealed Neo preflight review changed');
      const input={options,current,directory,reviewId:plan.id,previous,revision:receipt.revision,review:receipt.review,phase:'plan' as const,emit};
      const assessed=await admitNeoAssessmentReceipt(input,receipt.assessment);
      // Reobserve every resource through the real master immediately before effects.
      // Its new review is equivalent to the old approval only when its whole plan is identical.
      const fresh=await master.preview();
      if(fresh.planDigest!==plan.digest||fresh.candidateDigest!==receipt.revision.digest||fresh.parentDigest!==state.appliedDigest)throw Error('Neo deployment changed after review; preflight a new plan');
      const revalidated=await assessNeoDeployment({...input,review:fresh,phase:'revalidate'});
      try{assertNeoAssessmentUnchanged(assessed,revalidated);}catch(error){
        emit({kind:'assessment',graph:receipt.revision.graph,phase:'revalidate',status:'blocked',report:revalidated.report,recording:revalidated.recording,
          error:'Neo changed since review; review the new observed system before deployment'});throw error;
      }
      await writeNeoDeliveryJson(join(directory,'plans',plan.id+'.revalidation.json'),{planId:plan.id,reviewId:fresh.reviewId,assessment:revalidated});
      const result = await master.apply(fresh.reviewId);
      const evidence=[{kind:'change-assessment-plan',digest:assessed.report.digest,runId:assessed.recording.runId},
        {kind:'change-assessment-revalidate',digest:revalidated.report.digest,runId:revalidated.recording.runId}];
      if (!result.ok) return { ok: false, runId: result.runId, evidencePath: result.evidencePath,evidence,
        ...(result.tracePath ? { tracePath: result.tracePath } : {}) };
      const applied = await master.getState();
      await publishNeoDeliveryTarget({ current, candidate: selected, revision: receipt.revision, master: applied,
        canonicalBytes: receipt.canonicalBytes, directory: join(current.directory, 'master') });
      const recorded = await readNeoDeliveryJson(join(current.directory, 'master/runs', result.runId + '.json'));
      await writeNeoDeliveryJson(join(current.directory, 'deployment.json'), recorded);
      await (options.restoreForward ?? restoreNeoDeliveryForward)(selected.target);
      emit({ kind: 'applied', target: selected.target, graph: receipt.revision.graph, revision: receipt.revision, master: applied });
      return { ok: true, runId: result.runId, evidencePath: result.evidencePath,evidence,
        ...(result.tracePath ? { tracePath: result.tracePath } : {}), metadata: { candidatePath: selected.path, revisionDigest: receipt.revision.digest,
          assessment:assessed as unknown as JsonObject,revalidation:revalidated as unknown as JsonObject } };
    },
    async verify(deployment) {
      if (!deployment.ok || typeof deployment.metadata?.candidatePath !== 'string'
        || typeof deployment.metadata.revisionDigest !== 'string') throw Error('Verify a proven applied Neo release');
      const selected = await readNeoDeliveryCandidate(deployment.metadata.candidatePath, current);
      const applied = await master.getState(), attempt = applied.attempts.at(-1);
      const revision = applied.revisions.find(revision => revision.digest === deployment.metadata!.revisionDigest);
      if (!revision || applied.appliedDigest !== revision.digest || attempt?.status !== 'applied'
        || attempt.runId !== deployment.runId || revision.source?.repository !== expectedRepository) throw Error('The applied Neo revision changed before verification');
      assertNeoDeliveryCandidateRevision(selected, revision);
      const graph = createIdentityGraph(selected.target, { includeNeo: true });
      const verified = await verifyNeoResourceFlow(selected.target, directory, options.checks, {
        connections(snapshot, result) { emit({ kind: 'connections', graph, snapshot, ...(result ? { result } : {}) }); },
        identity(snapshot, result) { emit({ kind: 'identity', graph, snapshot, ...(result ? { result } : {}) }); },
      });
      return { ok: verified.ok, checks: verified.checks, metadata: {
        receipts: (verified.receipts ?? []).map(receipt => ({ id: receipt.id, runId: receipt.runId ?? '', evidencePath: receipt.evidencePath ?? '' })),
      } };
    },
  };
}

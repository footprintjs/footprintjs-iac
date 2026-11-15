import { join } from 'node:path';
import { validateInfraGraph } from '../../../src/graph/index.ts';
import { loadEvidence } from '../../../src/evidence.ts';
import { MasterWorkflow } from '../../../src/master/workflow.ts';
import { FileMasterStore } from '../../../src/master/store.ts';
import type { identityEngine } from '../engine.ts';
import { createIdentityGraph } from '../graph.ts';
import type { IdentityTarget } from '../target.ts';
import { readNeoDeliveryJson, writeNeoDeliveryJson } from './files.ts';
import { neoDeliveryTarget, neoInitialDeliveryRevision } from './target.ts';
import type { NeoDeliveryBaseline, NeoDeliveryObservation } from './types.ts';

export async function readNeoDeliveryBaseline(path: string, target: IdentityTarget): Promise<NeoDeliveryBaseline> {
  const recorded = await readNeoDeliveryJson(path) as NeoDeliveryBaseline;
  const graph = validateInfraGraph(recorded.graph);
  const evidence = await loadEvidence(recorded.result.evidencePath);
  if (!recorded.result.ok || !Array.isArray(recorded.events)
    || graph.digest !== createIdentityGraph(target, { includeNeo: true }).digest
    || evidence.runId !== recorded.result.runId || evidence.graph?.digest !== graph.digest
    || !evidence.structure || !evidence.deploymentChart) throw Error('Neo baseline needs a complete matching native deployment');
  return { ...recorded, graph };
}

/** The existing master controls promotion; this composition only archives actual native results. */
export async function prepareNeoDeliveryMaster(target: IdentityTarget, repository: string,
  native: ReturnType<typeof identityEngine>, emit: (event: NeoDeliveryObservation) => void) {
  const directory = join(target.directory, 'master');
  const engine = {
    plan: native.engine.plan.bind(native.engine),
    async apply(...args: Parameters<typeof native.engine.apply>) {
      const graph = validateInfraGraph(args[0]);
      const update = () => emit({ kind: 'deployment', graph, snapshot: native.recorder.getSnapshot() });
      const stopEvents = native.recorder.subscribe(update), stopCharts = native.recorder.subscribeChart(update);
      try {
        const result = await native.engine.apply(...args);
        const record = { graph, result, events: native.recorder.getEvents() };
        await writeNeoDeliveryJson(join(directory, 'runs', result.runId + '.json'), record);
        emit({ kind: 'deployment', graph, snapshot: native.recorder.getSnapshot(), result });
        return result;
      } finally { stopEvents(); stopCharts(); }
    },
  };
  const workflow = new MasterWorkflow({ engine, store: new FileMasterStore(directory), target: neoDeliveryTarget(target) });
  let state = await workflow.getState();
  const applied = state.attempts.findLast(attempt => attempt.status === 'applied');
  const baseline = await readNeoDeliveryBaseline(applied?.kind === 'apply' && applied.runId
    ? join(directory, 'runs', applied.runId + '.json') : join(target.directory, 'deployment.json'), target);
  if (!state.appliedDigest) {
    state = await workflow.adopt(neoInitialDeliveryRevision(target, repository), baseline.result);
    await writeNeoDeliveryJson(join(directory, 'runs', baseline.result.runId + '.json'), baseline);
  } else if (state.revisions.find(revision => revision.digest === state.appliedDigest)?.graph.digest !== baseline.graph.digest) {
    throw Error('The applied master and canonical Neo target disagree');
  }
  return { workflow, baseline, directory };
}

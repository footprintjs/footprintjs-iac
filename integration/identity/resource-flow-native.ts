import { join } from 'node:path';
import type { ApplyResult, InfraEngine } from '../../src/engine.ts';
import type { InfraGraph } from '../../src/graph/types.ts';
import { fingerprintPlan } from '../../src/master/plan.ts';
import type { DeploymentRecorder } from '../../src/progress/types.ts';
import { ResourceFlowAdapterError } from '../../src/resource-flow/index.ts';
import { writeNeoFlowJson } from './resource-flow-files.ts';

/** A child operation retains its real native run, graph and exact actions. */
export async function applyNeoFlowGraph(engine: InfraEngine, recorder: DeploymentRecorder, graph: InfraGraph,
  directory: string, phase: 'acquire' | 'connect'): Promise<ApplyResult> {
  const plan = await engine.plan(graph);
  if (phase === 'connect' && plan.operations.some(operation => operation.resource.provider !== 'kubernetes')) {
    throw Error('A connection plan cannot mutate its referenced identity services');
  }
  const result = await engine.apply(graph, { expectedPlanDigest: fingerprintPlan(plan) });
  await writeNeoFlowJson(join(directory, 'infra', result.runId + '.json'), { phase, graph, result, events: recorder.getEvents() });
  const receipt = { id: 'neo-native-' + phase, runId: result.runId, evidencePath: result.evidencePath };
  if (!result.ok) throw new ResourceFlowAdapterError('native-' + phase + '-failed', receipt);
  if (result.chartStatus?.published !== true || result.chartStatus.failed || result.traceStatus?.flushed !== true || result.traceStatus.failed) {
    throw new ResourceFlowAdapterError('native-' + phase + '-incomplete', receipt);
  }
  return result;
}

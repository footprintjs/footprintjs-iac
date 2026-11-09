import { FlowChartExecutor } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';
import { freeze } from '../graph/data.ts';
import { assertExecutableGraph, validateInfraGraph } from '../graph/validation.ts';
import type { InfraGraph } from '../graph/types.ts';
import { errorMessage } from '../util.ts';
import { createSynthesisChart } from './create-synthesis-chart.ts';
import { guardOutput } from './recorder.ts';
import type { OutputArtifact, SynthesisEvidence, SynthesisOptions, SynthesisResult } from './types.ts';

export class SynthesisError extends Error {
  readonly evidence: SynthesisEvidence;
  constructor(message: string, evidence: SynthesisEvidence) { super(message); this.name = 'SynthesisError'; this.evidence = evidence; }
}
/** Recorded compilation only: no provider observation, mutation, filesystem or deployment. */
export async function synthesize(input: InfraGraph, options: SynthesisOptions): Promise<SynthesisResult> {
  const graph = validateInfraGraph(input);
  assertExecutableGraph(graph);
  if (!Array.isArray(options.outputs) || !options.outputs.length || options.outputs.length > 32) throw new Error('Synthesis requires 1..32 output adapters');
  if (new Set(options.outputs.map(output => output.id)).size !== options.outputs.length) throw new Error('Duplicate output adapter id');
  const outputs = options.outputs.map(output => guardOutput(output, graph));
  const artifacts: OutputArtifact[] = [];
  const chart = createSynthesisChart(graph, outputs, artifacts);
  const executor = new FlowChartExecutor(chart, { readTracking: 'full', writeProvenance: 'reads-prefix' });
  const control = controlDepRecorder();
  executor.enableNarrative();
  executor.attachCombinedRecorder(control);
  for (const output of outputs) executor.attachEmitRecorder(output.recorder);
  for (const recorder of options.recorders ?? []) executor.attachCombinedRecorder(recorder);
  let failed: unknown;
  try { await executor.run(); } catch (error) { failed = error; }
  const snapshot = executor.getSnapshot();
  const controlDeps: Record<string, unknown> = {};
  for (const commit of snapshot.commitLog) if (commit.runtimeStageId) {
    const dependency = control.asLookup()(commit.runtimeStageId);
    if (dependency) controlDeps[commit.runtimeStageId] = dependency;
  }
  const evidence: SynthesisEvidence = { snapshot, structure: chart.buildTimeStructure, controlDeps, decisions: control.getDecisions(), narrative: executor.getNarrativeEntries() };
  if (failed) throw new SynthesisError(errorMessage(failed), evidence);
  const failure = snapshot.sharedState.failure as { message: string } | null;
  if (failure) throw new SynthesisError(failure.message, evidence);
  return freeze({ kind: 'synthesis-result', version: 1, graphDigest: graph.digest, artifacts, ...evidence });
}

import { flowChart } from 'footprintjs';
import type { InfraGraph } from '../graph/types.ts';
import { finalizeStage, resourceStage, validateStage } from './stages.ts';
import type { GuardedOutput, OutputArtifact, SynthesisState } from './types.ts';

/** The single construction file for the recorded synthesis flowchart. */
export function createSynthesisChart(graph: InfraGraph, outputs: GuardedOutput[], artifacts: OutputArtifact[]) {
  let chart = flowChart<SynthesisState>('Validate desired model', validateStage(graph), 'validate-model');
  for (const resource of graph.resources) chart = chart.addFunction(`Emit ${resource.id}`, resourceStage(resource), `emit-${resource.id}`);
  return chart.addFunction('Finalize and validate outputs', finalizeStage(outputs, artifacts), 'finalize-outputs').build();
}

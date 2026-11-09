import type { TypedScope } from 'footprintjs';
import { jsonCopy } from '../graph/data.ts';
import type { InfraGraph } from '../graph/types.ts';
import type { Resource } from '../types.ts';
import { errorMessage } from '../util.ts';
import { RESOURCE_EVENT, type GuardedOutput, type OutputArtifact, type SynthesisState } from './types.ts';

export function validateStage(graph: InfraGraph) {
  return (scope: TypedScope<SynthesisState>) => {
    scope.$setValue('graphDigest', graph.digest);
    scope.$setValue('expectedResourceIds', graph.resources.map(resource => resource.id));
    scope.$setValue('failure', null);
  };
}
export function resourceStage(resource: Resource) {
  return (scope: TypedScope<SynthesisState>) => {
    void scope.$getValue('graphDigest');
    scope.$setValue(`resource:${resource.id}`, jsonCopy(resource));
    scope.$emit(RESOURCE_EVENT, { resource: scope.$getValue(`resource:${resource.id}`) });
  };
}
export function finalizeStage(outputs: GuardedOutput[], artifacts: OutputArtifact[]) {
  return (scope: TypedScope<SynthesisState>) => {
    for (const id of scope.$getValue('expectedResourceIds') as string[]) void scope.$getValue(`resource:${id}`);
    try {
      const complete = outputs.map(output => output.finalize());
      const paths = complete.flatMap(output => output.files.map(file => file.path));
      if (new Set(paths).size !== paths.length) throw new Error('Output adapters produced duplicate file paths');
      scope.$setValue('artifacts', jsonCopy(complete));
      artifacts.push(...complete);
    } catch (error) {
      scope.$setValue('failure', { phase: 'finalize', message: errorMessage(error) });
    }
  };
}

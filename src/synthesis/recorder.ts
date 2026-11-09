import type { EmitEvent } from 'footprintjs';
import { identifier, jsonCopy, object } from '../graph/data.ts';
import type { InfraGraph } from '../graph/types.ts';
import { canonical, errorMessage } from '../util.ts';
import { validateArtifact } from './artifact.ts';
import { RESOURCE_EVENT, type GuardedOutput, type OutputAdapter, type OutputRecorder } from './types.ts';

function assertSynchronousCallback(callback: unknown): void {
  if (typeof callback !== 'function' || ['AsyncFunction', 'AsyncGeneratorFunction', 'GeneratorFunction'].includes(Object.getPrototypeOf(callback)?.constructor?.name)) {
    throw new Error('Output callbacks must be synchronous');
  }
}
function rejectAsync(value: unknown): void {
  if (value instanceof Promise) { void value.catch(() => undefined); throw new Error('Output callbacks must not return a Promise'); }
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) throw new Error('Output callbacks must not return a thenable');
}

/** Observer isolation must never turn a broken compiler into an accepted artifact. */
export function guardOutput(adapter: OutputAdapter, graph: InfraGraph): GuardedOutput {
  const id = identifier(adapter.id, 'output adapter id');
  assertSynchronousCallback(adapter.create);
  const output = adapter.create(graph);
  rejectAsync(output);
  if (!output || output.id !== id || typeof output.onEmit !== 'function' || typeof output.finalize !== 'function'
    || 'then' in output) throw new Error('Output adapter must create a synchronous recorder with matching identity');
  assertSynchronousCallback(output.onEmit);
  assertSynchronousCallback(output.finalize);
  const failures: string[] = [];
  const received = new Set<string>();
  const expected = new Map(graph.resources.map(resource => [resource.id, resource]));
  return {
    recorder: {
      id,
      onEmit(event: EmitEvent) {
        if (event.name !== RESOURCE_EVENT) return;
        try {
          const payload = object(jsonCopy(event.payload), 'synthesis event');
          const resource = object(payload.resource!, 'synthesis resource');
          const resourceId = identifier(resource.id, 'synthesis resource id');
          if (!expected.has(resourceId) || received.has(resourceId) || canonical(resource) !== canonical(expected.get(resourceId))) throw new Error('Unexpected, duplicate or changed synthesis resource');
          rejectAsync(output.onEmit!.call(output, { ...event, payload }));
          received.add(resourceId);
        } catch (error) { failures.push(errorMessage(error)); }
      },
      toSnapshot: () => ({ name: id, data: { resources: [...received], errors: [...failures] }, description: 'Output projection coverage; finalization is checked separately.' }),
    },
    finalize() {
      if (failures.length || received.size !== expected.size) throw new Error(`Output recorder ${id} is incomplete: ${failures.join('; ') || 'missing resources'}`);
      const result = output.finalize();
      rejectAsync(result);
      return validateArtifact(result, graph, id);
    },
  };
}

/** Shared exact-resource collector for the built-in native output projections. */
export function resourceCollector(id: string, graph: InfraGraph, finalize: (resources: InfraGraph['resources']) => ReturnType<OutputRecorder['finalize']>): OutputRecorder {
  const resources: InfraGraph['resources'] = [];
  return {
    id,
    onEmit(event) {
      if (event.name === RESOURCE_EVENT) resources.push((event.payload as { resource: InfraGraph['resources'][number] }).resource);
    },
    finalize: () => finalize(resources.sort((a, b) => a.id.localeCompare(b.id))),
  };
}

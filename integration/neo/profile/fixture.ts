import type { JsonObject } from '../../../src/types.ts';
import { createNeoStack } from '../stack.ts';
import type { NeoImages } from './options.ts';

export function fixtureSpec(id: 'neo-namespace' | 'neo-app' | 'neo-service', images?: NeoImages): JsonObject {
  const resource = createNeoStack(images).resources.find(resource => resource.id === id);
  if (!resource) throw new Error('Missing packaged Neo fixture resource: ' + id);
  return resource.spec;
}
export function deploymentSpec(images: NeoImages, replicas: number): JsonObject {
  const spec = fixtureSpec('neo-app', images);
  (spec.spec as JsonObject).replicas = replicas;
  return spec;
}

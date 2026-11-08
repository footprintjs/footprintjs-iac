import type { Capability } from '../../../src/system/types.ts';
import type { LoweredCapability, LoweringContext } from '../../../src/binding/types.ts';
import { neoSupport } from './support.ts';
import { artifactImages } from './options.ts';
import { deploymentSpec, fixtureSpec } from './fixture.ts';

export function lowerNeoCompute(capability: Capability, context: LoweringContext): LoweredCapability {
  const support = neoSupport(capability, context, 'compute');
  if (!support.supported) throw new Error('Unsupported local Neo compute: ' + support.unsupportedRequirements.join(', '));
  const images = artifactImages(context.artifact(capability.properties.program));
  const namespace = context.resourceId('namespace');
  const deployment = context.resourceId('deployment');
  return { resources: [
    { id: namespace, provider: 'kubernetes', spec: fixtureSpec('neo-namespace') },
    { id: deployment, provider: 'kubernetes', dependsOn: [namespace], spec: deploymentSpec(images, capability.properties.replicas as number) },
  ] };
}

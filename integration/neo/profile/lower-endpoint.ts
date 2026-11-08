import type { Capability } from '../../../src/system/types.ts';
import type { LoweredCapability, LoweringContext } from '../../../src/binding/types.ts';
import { neoSupport } from './support.ts';
import { fixtureSpec } from './fixture.ts';

export function lowerNeoEndpoint(capability: Capability, context: LoweringContext): LoweredCapability {
  const support = neoSupport(capability, context, 'endpoint');
  if (!support.supported) throw new Error('Unsupported local Neo endpoint: ' + support.unsupportedRequirements.join(', '));
  const target = context.mapping(capability.properties.target);
  if (target.capabilityId !== 'neo-app' || target.mode !== 'real' || target.resourceIds.length !== 2 || target.exitPoints.length !== 1) {
    throw new Error('Neo endpoint must target the real local Neo compute expansion');
  }
  return { resources: [{ id: context.resourceId('service'), provider: 'kubernetes', spec: fixtureSpec('neo-service') }] };
}

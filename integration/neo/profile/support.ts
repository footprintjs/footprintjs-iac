import { canonical } from '../../../src/util.ts';
import type { Capability } from '../../../src/system/types.ts';
import type { Json } from '../../../src/types.ts';
import type { SupportAssessment, SupportContext } from '../../../src/binding/types.ts';
import { artifactImages, assertNeoTarget } from './options.ts';

export function neoSupport(capability: Capability, context: SupportContext, role: 'compute' | 'endpoint'): SupportAssessment {
  const requirements: SupportAssessment['requirements'] = [];
  const unsupported = new Set<string>();
  try { assertNeoTarget(context); } catch { unsupported.add('target'); }
  const exactCapability = role === 'compute'
    ? capability.family === 'compute' && capability.kind === 'service' && capability.id === 'neo-app' && capability.path === 'application.neo-app'
    : capability.family === 'network' && capability.kind === 'endpoint' && capability.id === 'neo-http' && capability.path === 'network.neo-http';
  if (!exactCapability) unsupported.add('fixture-capability');
  const required = role === 'compute' ? ['program', 'replicas'] : ['protocol', 'port', 'target'];
  for (const property of required) if (!Object.hasOwn(capability.properties, property)) unsupported.add(property);
  for (const [property, requested] of Object.entries(capability.properties)) {
    let supported = false;
    if (role === 'compute' && property === 'program') {
      try {
        supported = canonical(requested) === canonical({ kind: 'artifact', id: 'neo-program' });
        if (supported) artifactImages(context.artifact(requested));
      } catch { supported = false; }
    } else if (role === 'compute' && property === 'replicas') supported = requested === 1 || requested === 2;
    else if (role === 'endpoint' && property === 'protocol') supported = requested === 'http';
    else if (role === 'endpoint' && property === 'port') supported = requested === 5230;
    else if (role === 'endpoint' && property === 'target') supported = canonical(requested) === canonical({ kind: 'service', path: 'application.neo-app' });
    if (!supported) unsupported.add(property);
    else requirements.push({
      property, requested, status: 'implemented',
      reason: property === 'program'
        ? 'The packaged local Neo Node/UI and Python tool containers are realized by the fixed Deployment manifest.'
        : property === 'replicas'
          ? 'The Deployment requests this exact replica count; the Kubernetes adapter independently waits for readiness.'
          : 'The fixed ClusterIP Service realizes the declared HTTP 5230 route to the Neo Deployment; this claim is not a live health verdict.',
    });
  }
  return {
    supported: unsupported.size === 0,
    reason: unsupported.size
      ? 'This local consumer profile supports only the packaged ephemeral Neo fixture and its explicit properties'
      : 'Fixed Neo Kubernetes fixture implementation; no general storage, identity, isolation or production guarantees',
    unsupportedRequirements: [...unsupported].sort(), requirements,
  };
}

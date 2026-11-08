import { infra, resource, type InfraGraph } from '../../src/graph/index.ts';
import { createNeoStack } from './stack.ts';

export type NeoGraphOptions = { nodeImage?: string; pythonImage?: string };

/**
 * Design metadata around the existing local trial resources.
 * These overlapping boundaries describe a view. They create no IAM, RBAC,
 * NetworkPolicy, geographic placement, or additional ownership guarantee.
 */
export function createNeoGraph(options: NeoGraphOptions = {}): InfraGraph {
  const stack = createNeoStack(options);
  const node = (id: string) => {
    const entry = stack.resources.find(candidate => candidate.id === id);
    if (!entry) throw new Error('Missing Neo trial resource: ' + id);
    return resource(entry.id, entry.provider, entry.spec, entry.dependsOn);
  };
  const namespace = node('neo-namespace');
  const app = node('neo-app');
  const service = node('neo-service');

  // The existing trial is a dependency chain; its graph must not invent a
  // parallel deployment merely to make the design view look more complex.
  return infra(stack.name)
    .boundary({
      id: 'neo-local-region', kind: 'region', label: 'Local trial region',
      attributes: { location: 'unspecified local test location', placementEnforcement: 'none' },
    })
    .boundary({
      id: 'neo-security-review', kind: 'security', label: 'Local fixture security review scope',
      attributes: {
        enforcement: 'descriptive-only',
        note: 'Membership does not create RBAC, NetworkPolicy, ingress protection or tenant isolation.',
      },
    })
    .boundary({
      id: 'neo-local-cluster', kind: 'physical', label: 'Local Kubernetes trial cluster',
      attributes: { schedulingEnforcement: 'none', note: 'No physical node affinity is introduced.' },
    })
    .boundary({
      id: 'neo-application-owner', kind: 'ownership', label: 'Neo application ownership context',
      attributes: {
        enforcement: 'descriptive-only',
        note: 'The provider adapter independently verifies actual resource ownership.',
      },
    })
    .boundary({ id: 'neo-runtime-role', kind: 'role', label: 'Application runtime' })
    .boundary({ id: 'neo-entry-role', kind: 'role', label: 'Application entry point' })
    .boundary({ id: 'neo-scope-role', kind: 'role', label: 'Kubernetes resource scope' })
    .start(namespace)
    .next(app)
    .next(service)
    .within('neo-local-region', namespace, app, service)
    .within('neo-security-review', app, service)
    .within('neo-local-cluster', namespace, app, service)
    .within('neo-application-owner', namespace, app, service)
    .within('neo-runtime-role', app)
    .within('neo-entry-role', service)
    .within('neo-scope-role', namespace)
    // Architecture direction is deliberately opposite to the creation edge:
    // the Service depends on Deployment readiness, then routes toward its pods.
    .connect(service, app, 'communicatesWith', 'ClusterIP routing to the selected pod on TCP 5230')
    .synth();
}

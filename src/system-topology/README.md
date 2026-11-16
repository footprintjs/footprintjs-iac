# Registered system topology

This optional, provider-free model describes where components belong and what
connects them. It is separate from the resource mutation graph: two services can
appear inside one server while one real systemd transaction updates both.

Use `footprintjs-iac/system-topology` in viewers for types, bounded readers and
pure projection. Use `footprintjs-iac/system-topology/node` in the private host
for declaration hashing and admission. Neither entry inspects a provider.

A consumer declares safe labels, compute/storage/network/identity categories,
existing/deployment/embedded origin, optional technology IDs, nested boundaries,
resource/unit bindings and the check IDs for each connection. Do not place
credentials, commands, connection addresses or arbitrary icon URLs in this DTO.
Registered intent is not evidence of an installed service or an enforced boundary.

```ts
import { defineSystemTopology } from 'footprintjs-iac/system-topology/node';
import { projectSystemTopology } from 'footprintjs-iac/system-topology';

const definition = defineSystemTopology({
  id: 'my-system', label: 'My application',
  boundaries: [{ id: 'server', label: 'Registered server', kind: 'host' }],
  nodes: [{
    id: 'api', label: 'Application', category: 'compute', origin: 'existing',
    boundaryId: 'server', technology: { id: 'nodedotjs', label: 'Node.js' },
    bindings: { resourceIds: ['services'], componentIds: ['api-unit'], checkIds: ['health'] },
  }],
  connections: [],
}, { targetId: registeredTarget.id, graphDigest: desiredGraph.digest });

const pending = projectSystemTopology(definition, {
  ...definition.binding, definitionDigest: definition.digest,
  configurationDigest: activeConfigurationDigest,
  resources: [], components: [], checks: [],
});
```

The trusted host admits native captures and supplies observations. An adapter
recorder event alone is provisional. Use the optional
`footprintjs-iac/adapter-flow/node` evidence admission helper before marking
retained component facts complete. It verifies the recorded child stage write
and parent deployment association. Required checks need their own admitted
CheckWorkflow receipts. Suite activity alone cannot establish that a particular
connection is checking or connected.

The projector keeps installed, running and connected facts distinct. Shared
resource readiness never establishes an independently bound unit observation.
Required missing/unknown checks, incomplete captures and changed configuration
bindings cannot inherit green state. A boundary's children completing does not
verify that boundary; declare and measure its own placement/identity checks.

Lens validates the declaration digest in its trusted server and recomputes the
pure view before accepting it. A projected public JSON object is not a signed
attestation; host registration and native receipt admission remain necessary.
The UI loads a small local technology icon allowlist with a generic fallback.

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

## Live actions inside component cards

`SystemTopologyObservations.actions` is optional. Existing view envelopes without
it keep their original shape. An action carries a resource/component binding,
phase, observed status and native run/runtime-stage reference. It is execution
metadata: it never increases `node.progress`, establishes installed/running
facts, changes an Existing origin, or makes a boundary ready.

```ts
import { liveTopologyActions } from 'footprintjs-iac/system-topology';
import { admitTopologyActions } from 'footprintjs-iac/system-topology/node';

const bindings = plan.operations.map(operation => ({
  adapterId: operation.resource.provider,
  resourceId: operation.resource.id,
  operationId: operation.operationId,
}));
const provisional = liveTopologyActions({
  deploymentRunId, nativeRunId: snapshot.runId, bindings,
  capture: adapterRecorder.getSnapshot(),
});
// Retained publication after native trace admission; this performs no provider work.
const admitted = await admitTopologyActions({
  evidence: savedDeploymentEvidence, plan,
  capture: adapterRecorder.getSnapshot(),
});
```

The native run ID is distinct from the deployment controller's run ID. Live
completion remains `status: 'passed', evidence.complete: false`; the UI can show
that the callback returned while admitting no new verified component facts.
Dropped or invalid recorder events are refused. Final admission reopens the
complete root and every child log, validates the plan/spec/intent/mount, and
reconstructs terminal actions from native scope writes in their actual delivery
order. Missing or reordered advisory history cannot restore an older action.
Each new deployment supplies its own actions; a no-op contains only the actual
verification work that ran, never a previous restart.

Projected `node.actions` adds a core-owned label and `scope: 'component'` or
`'shared-resource'`. Component IDs select only their registered cards. Shared
provider phases select only cards with component bindings; a check-only existing
database never borrows a service restart or appears to be created. Nodes may
have multiple concurrent actions. The ordered list retains the latest native
write for each resource/component/phase/runtime-stage identity so a viewer can
show active actions and link the exact recorded step. Unknown external callback
internals are not expanded into fictional actions. Connection checks continue
to use their own admitted check receipts and references.

Adapters can declare `AdapterPhase.componentId` only when a real phase addresses
one registered component. This emits an honest component-specific start before
the callback. Explicit terminal measurements—including failed or unknown
observations—win over the generic wrapper completion; a callback without
measurements cannot acquire installed/running facts from an earlier phase.

# Optional agent platform foundation

This module describes an agent revision and measures whether its registered
execution environment is ready. Infrastructure deployment remains in
InfraChart; reasoning and tool execution remain in the consuming agent SDK.
The wrapper composes the existing native ResourceFlowWorkflow. It introduces
no Kubernetes controller, scheduler, second deployment engine or conversation
runtime.

This working branch requires a release containing the `agent-platform` and
`agent-platform/node` exports. Earlier alpha releases do not provide them.
Importing either module starts no provider operation. An application can load
the module only when its agent feature is selected. The separate Lens feature
can consume the resulting data without putting React in this package.

## Immutable revision and infrastructure association

```ts
import {
  defineAgentRevision,
  defineAgentDeployment,
} from 'footprintjs-iac/agent-platform';
import {
  AgentReadinessWorkflow,
  FileResourceFlowStore,
} from 'footprintjs-iac/agent-platform/node';

const revision = defineAgentRevision({
  agentId: 'neo',
  behavior: {
    id: 'storage-triage',
    digest: reviewedBehaviorDigest,
    reference: 'artifact:reviewed-behavior',
  },
  runtime: {
    id: 'registered-runtime',
    digest: reviewedRuntimeDigest,
    reference: 'artifact:reviewed-runtime',
  },
});

const definition = defineAgentDeployment({
  id: 'neo-agent-readiness',
  label: 'Neo agent',
  revision,
  target: registeredTarget,
  resourceIds: ['neo-deployment', 'neo-service'],
  environmentResourceId: 'neo-deployment',
  mode: 'existing',
  requiredCheckIds: ['health', 'login', 'allowed', 'denied'],
  capabilityIds: ['conversationAuthorization'],
  requiredCapabilities: ['conversationAuthorization'],
}, admittedInfrastructureGraph);
```

The revision is a content-addressed declaration of behavior and runtime
artifacts. It does not prove that an external runtime uses those artifacts.
The trusted runtime adapter must measure the actual binding in verification.
References contain artifact identifiers or credential-free addresses, never
prompts, model keys, passwords or raw configuration objects.

The deployment factory validates the complete infrastructure graph and checks
that all associated resource IDs exist. The workflow constructor receives that
graph again, so an imported JSON definition cannot silently select a different
graph, target or environment resource. Returned declarations are detached and
deeply frozen. A changed revision requires a new declared lifecycle invocation;
it cannot resume another revision's pending checkpoint.

## Native lifecycle and primitive adapters

```ts
const workflow = new AgentReadinessWorkflow({
  definition,
  graph: admittedInfrastructureGraph,
  store: new FileResourceFlowStore(privateStateDirectory),
  profiles: registeredImmutableProfiles,
  requireProfileAtStart: true,
  adapters: trustedEnvironmentPrimitives,
});

const unsubscribe = workflow.subscribe(state => publishSafeView(state));
const state = await workflow.start({ profileId: selectedProfileId });
```

The dedicated composition file, `create-agent-readiness-flow.ts`, creates the
base native flow:

**Create/Find environment → resolve details or human pause → Connect → Verify**

Each primitive receives the native operation context plus `agentId`,
`revisionDigest`, `deploymentId` and `deploymentDigest`. The host registers the
implementations of `create`, `find`, `resolveDetails`, `validate`, `connect` and
`verify`; browser requests cannot supply commands or executable adapters.
`create` is required only for Create mode. Existing mode never falls back to
creation when Find fails.

This is a post-acquisition readiness workflow, not a compatibility planner.
Run infrastructure assessment and review before admitting a mutable Create
primitive. A ready application and an enforced sandbox are different claims.

The verification result contains the exact request binding, ordinary measured
checks and capability observations:

```ts
return {
  request: {
    operationId: context.operationId,
    agentId: context.agentId,
    revisionDigest: context.revisionDigest,
    environmentPhysicalId: resource.physicalId,
    scope: resource.scope,
  },
  ok: true,
  checks: [{ id: 'health', passed: true }],
  capabilities: [{
    id: 'conversationAuthorization',
    status: 'supported',
    proof: { id: 'two-user-access-check', runId: nativeAccessRunId },
  }],
};
```

The request must match this invocation's operation, revision and measured
physical resource. A `supported` claim requires an opaque native proof receipt
with a run ID or evidence reference. The host remains responsible for measuring
and admitting the referenced external evidence. This generic contract cannot
prove an arbitrary runtime's internals from an assertion alone.

## Capabilities and readiness

Four baseline capability IDs are always present:

| ID | What support would establish |
|---|---|
| `conversationIsolation` | Isolation of each conversation's execution environment |
| `revisionRouting` | A conversation continues to execute its pinned revision |
| `durableDataRestore` | Saved durable data can be restored by the runtime |
| `processMemoryRestore` | Process memory can be restored by the runtime |

Every baseline defaults to `unknown`. Up to 32 additional simple, registered
capability IDs can be declared without changing the core. Only registered IDs
are admitted in a verification result; required capabilities must belong to the
definition's immutable registration. Unknown and unsupported are separate
outcomes. Ordinary shared Neo processes can report conversation authorization
while leaving execution isolation and revision routing unsupported.

An agent becomes `ready` only when the native flow passes, its required checks
pass, its required capabilities have supported observations with receipts, and
its retained native recording is complete and bound to the definition. Optional
unsupported capabilities remain visible; a ready application does not imply
support for all runtime features. Adapter failures or incomplete capture cannot
produce ready state.

Capability facts and proof receipts are encoded into the base flow's native
verification data. There is no detached capability-success ledger. The raw
`flow` field preserves the native stages, events, physical handle, pause token
and recording segments for a viewer.

## Pause, reopen and evidence

When details need a person, the base workflow saves its native interrupt and
releases its lock. Resume with the exact pending `pauseToken` and selected
immutable `profileId`. Create is not repeated. Changed target identity,
definition, revision or profile meaning prevents resumption.

`snapshot()` performs no provider call and never starts an idle or missing
workflow. A new reader treats a retained running intent as incomplete; only the
instance driving an active operation may describe it as live. That uncertainty
does not authorize another invocation or a blind retry. It validates the
retained native segment run IDs, complete JSONL
traces, definition binding, final resource/verification data and SDK-recorded
event history. The native revision-binding recorder preserves the readable
manifest. The JSONL independently binds committed configuration digests and
state; recorder metadata and event timestamps retain SDK snapshot provenance
and are not independently stored by that JSONL sink.

FootPrint replay explains a recorded workflow. Human workflow resume, durable
data restoration and process-memory restoration remain separate capabilities.
This module does not implement conversation scheduling, per-user actors, tool
effect rollback or a universal snapshot engine. Actual turn recordings should
be linked through the consuming SDK's conversation, revision and turn IDs.

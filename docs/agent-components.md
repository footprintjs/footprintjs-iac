# Native agent component graph

The optional agent component layer describes an agent's actual execution and
state dependencies below the high-level readiness card. It composes the existing
native ResourceFlow/AgentReadiness lifecycle; Kubernetes, systemd and storage
technologies stay behind registered primitive adapters.

The declaration and projection entrypoint imports no provider or React code:

```ts
import {
  defineAgentComponentGraph,
  projectAgentComponents,
} from 'footprintjs-iac/agent-platform/components';
import {
  AgentComponentsWorkflow,
} from 'footprintjs-iac/agent-platform/components/node';
```

## Declare logical roles and actual containment

```ts
const components = defineAgentComponentGraph({
  id: 'neo-components', label: 'Neo runtime',
  components: [
    {
      id: 'worker', label: 'Agent worker', kind: 'execution', roles: ['worker'],
      mode: 'existing', resourceIds: ['neo-deployment'],
      environmentResourceId: 'neo-deployment', requiredCheckIds: ['runtime-pin', 'health'],
      required: true, boundaryId: 'runtime',
    },
    {
      id: 'session-state', label: 'Session and conversation state',
      kind: 'store', roles: ['session-state', 'conversation-history'],
      storage: 'memory', sharing: 'shared', physicalGroupId: 'neo-session-store',
      mode: 'existing', resourceIds: ['neo-deployment'],
      environmentResourceId: 'neo-deployment', requiredCheckIds: ['owned-readback'],
      required: true, boundaryId: 'runtime',
    },
  ],
  boundaries: [{
    id: 'runtime', label: 'Registered execution environment', kind: 'service',
    strategy: { id: registeredStrategy.id, label: registeredStrategy.label },
    realizedBy: 'worker', requiredCheckIds: ['runtime-pin'],
  }],
  relations: [{ id: 'worker-state', from: 'worker', to: 'session-state', kind: 'order' }],
}, admittedAgentDeployment, admittedInfraGraph);
```

A component can be `execution`, `store`, `context` or `connection`. Its `roles`
are semantic uses, not additional physical resources. A shared memory store can
serve session state and conversation history. Duplicate `physicalGroupId` values
on store nodes are rejected so one declared physical store is drawn once.
Memory, sharing and durability labels are declarations; their required native
checks must actually measure the site's configuration and behavior.

`order` establishes deployment/readiness prerequisites. `contains` describes
containment already expressed by `boundaryId`/`parentId`. `supports` describes
architecture. `communicatesWith` describes an independently measured connection;
a required communication relation must name its selected, required `connection`
component via `checkComponentId`. Neither containment nor communication silently
creates an ordering dependency.

Boundary kinds are technology-neutral placement concepts (`platform`, `host`,
`namespace`, `pod`, `container`, `service`, `shared`, `isolation`). The library
does not switch on strategy IDs. A systemd adapter can describe host/service/
process reality; Kubernetes can describe observed namespace/Pod/container
reality. Do not draw a container simply because an app runs through systemd.

Declaring a strategy or a security boundary does not realize it. A boundary is
`observed` only after its `realizedBy` component retains a native physical handle,
a complete admitted capture and passing declared boundary check IDs. Those
check IDs must be part of that component's required verification checks. A
closed failed component can still establish a passing identity check while
showing another failed check. `isolation` additionally requires a supported
native `conversationIsolation` capability with proof. Health alone cannot make
an isolation boundary observed.

## Execute through native small subflows

```ts
const workflow = new AgentComponentsWorkflow({
  definition: components,
  deployment: admittedAgentDeployment,
  graph: admittedInfraGraph,
  directory: privateAttemptDirectory,
  maxConcurrency: 4,
  components: {
    worker: { profiles: registeredProfiles, adapters: workerPrimitives },
    'session-state': { profiles: registeredProfiles, adapters: sessionPrimitives },
  },
});
const stop = workflow.subscribe(state => {
  publishSafeView(projectAgentComponents(components, state));
});
const result = await workflow.start({ profileId: selectedSavedProfile });
```

The pure DAG compiler creates bounded dependency batches. A native FootPrint
selector records whether each component runs or remains complete/unselected/
blocked. Selected component branches are mounted native subflows; independent
branches really overlap and join before dependent work. Each child reuses the
existing recorded **Create/Find → details or human pause → Connect → Verify**
workflow. Existing mode never falls back to creation. The fixed four-phase
component progress can therefore distinguish finding an existing store from
creating a new one.

The component and parent graph are bound to the admitted infrastructure graph,
agent revision, target and deployment. Native coordinator results explicitly
reference each child's native run IDs and observation digest. Native scope
reads, dependency decisions, mounted subflows, fork/join events and physical
verification remain available for drilldown. This is not a second scheduling
engine or an automatic universal cross-run causal resolver.

The initial component graph is a finite DAG; declaration cycles are rejected.
The underlying FootPrint engine supports decisions, loops and dynamic parallel
work, and native agent-turn recordings can contain those shapes. This API does
not invent loop progress, a conversation scheduler or per-conversation sandbox
provisioning. A future dynamic component composition must provide truthful work
bounds before displaying a percentage.

## Progress and readiness

`projectAgentComponents()` accepts admitted workflow state and makes no provider
call. Nodes count passed native lifecycle stages out of four. Boundary counts
aggregate selected required descendants, required connection check components
relevant to the boundary, and its identity anchor. The unit is **stages**, not
time. Reused identity-anchor work is not another physical deployment.

Unknown/incomplete capture sets indeterminate progress. Unselected components
remain skipped rather than completed. An empty unobserved boundary does not
become ready. All required selected components and their ancestor boundaries
must be verified before the graph becomes ready. A required connection cannot
be green because its endpoints merely exist.

Required work skipped by a dependency gate still contributes to the planned
denominator and never counts as ready. A verified identity anchor cannot turn
such a partially checked boundary green.

A known optional independent failure stays visible without blocking required
readiness. An optional failed prerequisite still prevents dependent required
work. Any paused or uncertain invocation keeps the operation unresolved, even
when that invocation was optional: starting another attempt is not an answer to
an outstanding native pause or uncertain provider effect.

## Pause, resume and read-only reopen

The parent saves intent before entering any child lifecycle. Each child also
saves its own native intent before provider effects. The per-directory lock and
synchronous operation guard prevent overlapping starts. A workflow is one-shot;
known failed attempts may be superseded only by a consumer-owned explicitly
new attempt after inspecting settled outcomes. An incomplete/running attempt
must not be bypassed with a new directory.

A Create acquisition exception is conservatively incomplete even if the child
ResourceFlow retained a native failed result: the remote provider might have
accepted creation before its response was lost. The component state preserves
that failed child capture while preventing a safe-retry interpretation.

A human pause retains the child's actual native checkpoint:

```ts
await workflow.resume({ componentId, pauseToken, profileId });
```

The exact selected child consumes its one-use token. Completed siblings are not
restarted; other paused siblings remain paused. Multiple parallel pauses can be
answered separately. The parent records a new coordinator segment containing
the previous coordinator run ID in native state and recorder metadata; the
child resumes its original native checkpoint. This explicit segment linkage
preserves the distinction between a resumed child and a new coordinator run.

`snapshot()` validates retained graph bindings, child recordings, parent JSONL
trace/replay and recorded child references without invoking a provider. Another
reader sees retained running intent as incomplete. Lost capture, changed graph/
revision/target/profile meaning, changed concurrency policy or edited native
child association cannot promote a retained result to ready. Native snapshots
and private receipts stay in the host; UI adapters should publish only safe
identities, statuses, opaque proof references and measured progress.

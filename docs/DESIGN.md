# A system design graph for infrastructure and AI investigation

The capability base now precedes the resource layer: see [CAPABILITIES.md](CAPABILITIES.md) for the approved compute/storage/network API, binding profiles and domain-wrapper extension point.

The consumer can also write a fluent declaration of resources, deployment dependencies and architectural boundaries. Synthesis produces one immutable, versioned JSON graph. Deployment planning, diagrams and execution evidence use the resource addresses in that graph. Declaring or rendering a graph performs no provider operations.

The application owns its resource definitions and composition root. The reusable IaC library owns graph semantics, validation, reconciliation and recording. The operator selects actual provider adapters, target and state store. Neo remains a consumer; the read-only triage application does not acquire infrastructure mutation credentials.

## Three distinct meanings

1. Architectural relations explain the intended system: communicatesWith, runsOn and assumesRole. Communication can be cyclic.
2. Deployment relations order effects: order and data. This projection must be acyclic. A declared data relation establishes a dependency; this release does not resolve provider outputs or prove field-level derivation.
3. Runtime evidence records what happened during a particular reconciliation. An architectural edge or earlier operation alone does not establish a runtime cause.

Serial composition connects each segment's exit frontier to the next segment's entry frontier. A parallel group adds no order between siblings. The next chained segment waits for all predecessors. Existing explicit dependencies remain authoritative. A bounded executor may run eligible resources concurrently; repeated apply still reconciles observed state and preserves no-op behavior.

One model can produce several architecture views; [Structurizr's DSL](https://docs.structurizr.com/dsl/tutorial) provides an established example of separating a model from its views.

The semantics follow established dependency graph scheduling, which Terraform also uses: [HashiCorp's graph documentation](https://developer.hashicorp.com/terraform/internals/graph). CDK's synthesis boundary is another useful precedent: [AWS CDK synthesis](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-synth.html).

## Boundaries are overlapping facets

A resource can belong to a region, security zone, architectural role, physical room and ownership group simultaneously. One universal nesting tree cannot express these independent dimensions. Optional same-kind parent relationships can express region hierarchies or site/room/rack organization; a generic group may contain another kind. Membership does not change stable resource identity, state ownership, deletion scope or provider target.

All boundaries in this version describe declared organization. Region attributes do not choose a real cloud target. A room label does not place a workload on a machine. Architectural roles do not grant IAM permissions. A security zone name does not isolate traffic.

Boundary requirements explicitly declare intended constraints. Required enforcement is rejected before provider observations because this release has no lowering/verifier for those requirements. Advisory requirements remain declarations. Future support must expose target capabilities, generate real provider policy and record verification status. It must never silently downgrade a required rule into a label. Kubernetes itself requires more than namespace grouping to isolate workloads: [Kubernetes multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/).

## Small modules and explicit composition

Graph types, fluent composition, synthesis, validation and rendering have separate modules. Resource handles and group combinators are declarations. No resource factory performs an external call. The operator injects provider and state interfaces into InfraEngine. This is [dependency injection](https://martinfowler.com/articles/injection.html) at a [composition root](https://blog.ploeh.dk/2011/07/28/CompositionRoot/), using [ports and adapters](https://alistair.cockburn.us/hexagonal-architecture).

Flowchart creation belongs in a dedicated create-apply-chart module. Stage behavior, scheduling, operation reconciliation, persistence coordination and trace lifecycle are separate helpers. Each future flowchart or subflow gets its own construction file. There is no global service locator and no automatic dependency discovery from folders.

An isolated scope adapter publishes distinct per-resource results through the pinned FootPrint 11.0.0 native root-write funnel so a join can record exact input keys. Its ScopeFacade.setGlobal method is exported by the advanced entry point but marked internal; dependency upgrades require the parallel result, native replay and failure-backwalk regressions. Shared failure state is written only by the root join.

The modules are small internal libraries with explicit imports. They can become separately versioned packages when there is an actual second consumer and a stable release boundary; a package per helper would add independent publishing overhead without improving dependency direction.

## Parallel effect safety

maxConcurrency defaults to one. Larger values execute bounded topological batches with native FootPrint branches and recorded joins. A batch waits for started siblings to settle. Once failure is observed, subsequent batches are skipped; successful effects remain managed. This first scheduler does not refill a free slot until its batch finishes. Cleanup/pruning stays sequential in reverse dependency order.

The engine keeps its whole-stack lock. A persistence coordinator serializes journal and state updates, captures state snapshots before enqueueing and stops subsequent persistence after a durable failure. Independent provider operations can overlap while inventory writes remain ordered. Simulator disk updates have their own instance-local transactions. The state store and simulator are single-machine facilities, not distributed coordination services.

## AI investigation contract

Each recording can retain the synthesized graph and digest. The digest identifies an artifact and detects changes; it does not authenticate its producer. explainRun provides a structured, read-only explanation with a flat Foottrace dependency slice, recorded failure and declared boundary memberships. It retains missing/truncated/coverage notes and does not issue an external root-cause verdict. An agent can connect a failed resource to its intended dependencies and boundary memberships, then query the recorded data/control slice. Saved replay only reconstructs recorded state; it sends no provider calls. A repair always creates a fresh reconciliation against current infrastructure.

The same complete recording and query provide reproducible evidence traversal. A known predicate and captured input can establish a specific validation failure. A provider timeout or missing child recording remains uncertain. A correlation identifier links activity; proving data derivation also requires explicit input/output mappings. External root cause is never inferred solely because a stage preceded a failure.

The current prototype still wraps a resource's observation, mutation, readiness and recovery inside one reconciliation stage. Planning occurs before the recorded apply chart. Fine-grained provider subflows, structured external effect receipts, source/field provenance, child tool recording links and an AI repair API remain explicit next increments. The fluent graph layer must not advertise those as already implemented.

## Compatibility and acceptance

Existing JSON Stack consumers remain supported. A graph is also a Stack, so it can be planned and applied through the same engine. Recognizable graph envelopes are revalidated at the execution boundary, including their digest and required constraints. CLI graph artifacts must retain the graph envelope; stripping it discards design constraints and is a different input.

Neo's graph fixture preserves the exact resource specifications and dependency order from the previously tested Kubernetes fixture. New graph acceptance is hermetic and separate from the saved live Kubernetes trial. No new production, collector, authentication or multi-replica application validation is implied.

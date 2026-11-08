# Capability base and domain wrappers

The developer-facing model describes compute (execution), storage (state), and network (communication). It uses familiar system concepts before selecting product implementations. Identity and access, placement and ownership remain crosscutting concerns.

The layers have separate responsibilities:

1. The capability base declares services/jobs, stores, segments/endpoints and typed relationships.
2. Recipes compose that base. Session and data store recipes expose the defaults they introduce.
3. Domain wrappers compose recipes for a particular type of system. Agentic and banking are possible wrapper domains, not cases in the generic compiler.
4. A binding profile chooses concrete adapters and resolves program artifacts.
5. The existing resource graph, planner and recorded reconciliation engine execute the expanded design.

## Consumer shape

```ts
import { system, artifact, ref } from 'footprint-iac/system';

const design = system('neo')
  .addNetwork('network', network =>
    network.addSegment('backend')
  )
  .addStorage('state', storage => storage
    .addSessionStore('sessions', sessions => sessions
      .sharing('shared')
      .durability('persistent')
      .expiration({ idle: '30m' })
    )
    .addDataStore('history', history => history
      .dataModel('relational')
      .durability('persistent')
      .retainOnRemoval()
    )
  )
  .addCompute('application', compute =>
    compute.addService('api', service => service
      .program(artifact('neo-api'))
      .useNetwork(ref.network('network.backend'))
      .useStorage(ref.store('state.sessions'), { access: 'readWrite' })
      .useStorage(ref.store('state.history'), { access: 'read' })
    )
  )
  .build();
```

These names describe system behavior. `artifact('neo-api')` is an abstract program reference; the binding profile supplies actual artifact configuration. No Kubernetes, container format, Redis or PostgreSQL selection is hidden in the base API.

Scoped callbacks are synchronous and close on completion. A captured child builder cannot be modified later. Build validates a strict JSON definition, resolves reference kinds and paths, checks dependencies, and returns a detached, deeply frozen definition with a canonical digest. The framework performs no provider calls during declaration or binding. Consumer callbacks and custom adapters remain trusted JavaScript extensions, not sandboxed code.

## Independent properties

| Dimension | Examples |
| --- | --- |
| Purpose | Session, application data, custom named purpose |
| Data model | Key-value, relational, document, object, file, block |
| Sharing | Local to a workload instance or shared among consumers |
| Durability | Ephemeral or persistent intent |
| Expiration | Idle expiration or absolute expiration |
| Retention | What happens on removal, plus an optional retention-period requirement |
| Replication | Number of copies requested |

Session store defaults are purpose `session` and model `keyValue`; data store defaults are purpose `data` and model `relational`. Explicit choices remove the corresponding default reason. The recipes do not silently set durability. Expiration and removal retention are different: session expiry does not imply deleting the infrastructure that stores sessions.

Persistent intent alone is not a universal failure guarantee. A real adapter must define the failures its implementation tolerates and support the requested behavior. Likewise, replication does not automatically establish availability or durability. The built-in binding profile in this release is a simulation and records these properties as simulated requirements, not verified production guarantees.

Compute supports services, jobs and interval-scheduled tasks. Network supports segments and endpoints. Program, schedule, typed resource references and access modes remain explicit. Optional principals describe actor intent; declaring a principal or using `runAs` does not by itself create an identity provider or prove authorization.

## Identity, composition and dependencies

A leaf name supplies its stable capability ID; IDs are unique across the system. A `group.leaf` path provides discovery and reference resolution. `stableId()` allows an explicit stable identity. Moving a capability between composition groups preserves its ID when its name or explicit ID is retained; changing a reference path must still update its users.

Nested calls describe composition, not deployment order. Typed store/network references generate appropriate dependencies. Architectural communication and deployment dependencies remain distinct; the deployment projection must be acyclic. The lower-level graph API continues to provide explicit serial/parallel scheduling declarations.

Region, security, role, physical and ownership boundaries remain overlapping views. Binding expands memberships over the resources implementing each capability. Unsupported required boundary enforcement is rejected, rather than converted into descriptive metadata.

## Binding and explanation

```ts
import { bindSystem, simulationProfile } from 'footprint-iac/binding';
import { InfraEngine, FileStateStore, SimulatorAdapter } from 'footprint-iac';

const engine = new InfraEngine({
  adapters: [new SimulatorAdapter()],
  store: new FileStateStore('.footprint-iac'),
  maxConcurrency: 2,
});
const binding = bindSystem(design, simulationProfile({
  artifacts: { 'neo-api': { executable: 'fixture-api' } },
}));

// Inspect binding.decisions, binding.mappings and binding.graph first.
const plan = await engine.plan(binding.graph);
const result = await engine.apply(binding.graph);
```

A profile specifies a target, selection rules, adapters and program artifacts. Ambiguous or missing matches fail. Every declared property requires an explicit support assessment; unknown properties and unsupported requirements fail. Simulated support is visibly distinct from an adapter's claimed real implementation. Neither is a runtime verification verdict.

The bound artifact contains resource mappings, entry/exit points, decisions, design digest and expanded graph. Capability composition groups preserve source IDs/paths, adapter IDs and simulation mode in the graph. Recorded failures can therefore report the originating capability through `explainRun`. This is a compilation mapping plus recorded resource-level execution evidence; it does not invent field-level runtime causality or an external root-cause proof.

The built-in capability adapter is simulation-only. It exercises this contract through the existing simulator resource provider. The existing low-level Kubernetes adapter remains available for explicit resource graphs; this release does not silently claim that it implements every capability in the base model.

## Real removal retention

`retainOnRemoval()` lowers to a resource lifecycle policy handled by the planner. Explicit prune/destroy retains omitted protected resources and their saved dependency closure. `Plan.retained` reports the resource IDs and reasons. They remain managed in saved inventory. Unrelated eligible resources can still be deleted in reverse dependency order.

Omitting the policy does not withdraw saved protection. Clear it explicitly with `retainOnRemoval(false)` or `retention({ onRemoval: 'delete' })`, apply that desired definition successfully, then perform a subsequent prune. A policy change alone does not send a provider mutation. Retention periods are requirements for adapters; they are not implemented by a timer in the IaC runner.

## Domain wrappers

A wrapper is a normal function that composes the public base. The `.use(recipe)` hook makes this composition readable. It must leave the expanded definition inspectable and its defaults visible. The separate recipe example demonstrates an agentic-style composition without creating a second deployment engine.

An agentic wrapper may add agent services, session state, long-term records and tool endpoints. A future banking wrapper may request transaction, audit-retention and access requirements. Those requirements need supported base capabilities/adapters; the wrapper's name does not establish compliance or guarantees. The core does not branch on a system-type enum.

See `examples/capabilities.ts` for executable declaration, binding, simulator reconciliation, failure investigation and retention acceptance. Intent views are produced with `systemToMermaid`/`systemToSvg`; expanded provider-resource views use the existing graph renderers.

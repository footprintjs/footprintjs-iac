# Recorded application delivery

The application-delivery workflow composes source acquisition, packaging and
release with the existing infrastructure engine. GitHub is a source adapter;
Kubernetes and other resource providers remain deployment adapters. No GitHub,
Docker or application-specific switch exists in the generic workflow.

When the deployment host needs a separate human-reviewed plan/apply step, use
[`SourcePreparationWorkflow`](source-preparation.md) for the four actual source
and package stages first. It hands exact native receipts to the normal review
host without running or inventing deployment stages.

The actual native FootPrint chart is:

```
Choose exact version → Get code → Build package → Store package
  → Review changes → Deploy changes → Check application
```

Each stage has its own adapter call and a durable intent record before the call.
The chart construction lives in `src/delivery/create-delivery-chart.ts`.
Declaring and validating a delivery performs no network, build or provider work.
Only `start()` executes its configured adapters. GitHub Actions and CI are not
required, enabled or dispatched by this workflow.

## Public modules

`footprintjs-iac/delivery` is browser-safe: definitions, state, adapter contracts
and bounded admission readers. `footprintjs-iac/delivery/workflow` is host-only:
`DeliveryWorkflow`, `FileDeliveryStore` and `loadDeliveryRecording`.

```ts
import { DeliveryWorkflow, FileDeliveryStore } from 'footprintjs-iac/delivery/workflow';
import type { DeliveryAdapters } from 'footprintjs-iac/delivery';

// Trusted host composition supplies the implementation and fixed settings.
declare const adapters: DeliveryAdapters;
const workflow = new DeliveryWorkflow({
  definition: {
    id: 'application-version-2',
    label: 'Application upgrade',
    target: { id: 'company-test', scope: 'fixed-cluster/namespace' },
    source: { repository: 'https://github.com/company/application.git', ref: 'v2' },
    recipe: { id: 'application-images', digest: 'a'.repeat(64) },
    configurationDigest: 'b'.repeat(64),
  },
  store: new FileDeliveryStore('/private/application-deliveries/version-2'),
  adapters,
});

const unsubscribe = workflow.subscribe(state => { /* project a safe viewer */ });
const outcome = await workflow.start();
unsubscribe();
```

Use real digests for build recipes and fixed host configuration. The example
digest literals only illustrate the required shape. Include packaging versions,
deployment target policy and acceptance-check identity in the configuration
digest so those inputs cannot silently change under a saved delivery.

## Adapter contracts

* `SourceAdapter.resolve(source, context)` freezes repository/ref to an exact
  commit/tree. `fetch(revision, context)` returns the same revision and a
  host-controlled source location. The workflow rejects a substituted repository,
  ref, commit or tree.
* `BuildAdapter.build(snapshot, recipe, context)` returns a named artifact set and
  its exact recipe digest. A recipe may include its own tests; the generic chart
  reports packaging, and does not pretend that building alone is an application
  acceptance test.
* `ArtifactStore.publish(build, context)` publishes or verifies a cached artifact
  set. The artifact names and content digests must match the build. References can
  change from a local build address to a registry address.
* `DeploymentAdapter.plan(publication, context)` returns the reviewed plan digest
  and affected resource actions. The adapter can compose `MasterWorkflow` to reuse
  immutable revisions, sealed reviews, differential updates and durable resource
  reconciliation. `deploy(plan, context)` returns the admitted native result.
* `DeploymentAdapter.verify(deployment, context)` returns nonempty measured checks.
  Overall success must equal every check's result. A negative deployment result or
  verification result fails the delivery and prevents later stages.

The fixed target and per-stage operation ID are supplied to every adapter.
Adapter credentials are supplied through trusted composition and existing secret
adapters; credentials, environment values and commands are not workflow inputs.
A browser may select only a configured delivery ID, not arbitrary repositories,
commands, filesystem paths or targets.

## Durable outcomes and evidence

One private store directory represents one immutable delivery attempt. Source,
recipe, configuration and target changes require a new definition and directory.
An occupied store lock rejects concurrent starts. Starting an already-passed
delivery returns its retained result without executing an adapter again.

Failed and incomplete attempts remain intact. A process crash can leave a
`running` ledger with an uncertain external outcome. The workflow deliberately
does not repeat that attempt automatically. Inspect the provider operation and
recorded receipts, reconcile using the provider's own operation identity, then
create a new bound attempt. Adapter-level idempotency and the existing master's
reconciliation remain responsible for safely reusing known external outcomes.

Private ledgers retain admitted source locations and opaque non-secret metadata
needed by host adapters. Do not return credentials in metadata or artifact
references. Browser views must project safe fields rather than sending the whole
host ledger. Native recordings omit source locations, evidence paths and opaque
adapter metadata. Local repository paths and `file:` source URLs are projected
to stable opaque source hashes consistently in definitions and version receipts;
the private ledger and definition digest retain the exact host binding. Public
network repository URLs such as HTTPS GitHub URLs remain readable. Their snapshots contain only source version identity, named
artifacts and content digests, reviewed resource actions, native run IDs, and
verification booleans. Raw adapter exceptions are normalized before recording.

All seven stages execute through the native recorder, using full read tracking
and per-write reads-prefix provenance. Native JSONL and evidence snapshots remain
read-only replay inputs. `loadDeliveryRecording(path, expected)` can bind a
recording read to the expected native run, execution and definition digest.
The native dependency chain records the admitted inputs and decisions in this
workflow; hidden source handles, build internals and external provider execution
require separate evidence. Cross-run correlation does not manufacture causal
edges.

The existing `Create/Find → Details → Connect → Verify` resource subflows stay
available underneath application delivery. Preparing application code does not
redefine compute, storage or network, and deploying an updated image does not
imply recreating its database or identity services.

# Neo as a release-pipeline consumer

This composition uses the generic `ReleasePreparationWorkflow`, sealed `ReleaseManifest`, `PipelineWorkflow`, direct strategy and `CheckRunner` contracts. Neo-specific paths, kind/Kubernetes commands, image checks and sign-in tests stay in this integration. The generic library contains no Neo branches.

The current adapter supports selective **direct application updates on already prepared local kind targets**. Each environment has a fixed host target and rollback is disabled. Canary traffic shifting, production hosting and data restoration are not implemented by this Neo adapter. Generic strategies remain available to other adapters that actually implement those operations.

Every normal Neo delivery/pipeline now performs a mandatory recorded preflight.
The master first observes all six current resources and computes the exact diff.
A separate native assessment records observations, capability evidence, policy
and admission decisions. Kubernetes changes use actual read-only server dry-run;
unchanged local identity containers use the master's measured observations with
an unchanged-only declared contract. Only the existing app may update. Create,
delete, replacement, blocked and unknown decisions stop before application
effects and retain their own native report. Application data impact remains
unknown; this consumer does not infer database migration from an image update.

The sealed plan binds the report digest and native run ID. Immediately before
apply, the consumer reobserves the full master plan, checks its unchanged digest,
runs another recorded assessment, and requires matching physical identity,
resource version, fingerprint, readiness and decision facts. The executor then
replans under its state lock and uses provider mutation preconditions. These
are point-in-time checks; they cannot predict every later runtime outage.

The explicit `ownedBootstrapServerSideApplyValidation` mode matches the actual
Kubernetes executor. It selects a dry-run force request up front only for the
framework's own verified create-manager fields, using the same conservative
field-ownership predicate as execution and exact UID/resourceVersion. Foreign
main-resource managers or overlapping status fields prevent that mode. A 409
never triggers a different validation strategy or merge fallback. This bounded
bootstrap transition is distinct from taking another manager's fields.

Lens receives `assessment` observations with `phase: plan | revalidate`,
`status: checking | checked | blocked`, the safe report and independent native
recording references. Delivery and pipeline native receipts contain bounded
`evidence` references (kind, content digest, run ID), including confirmed
pre-effect refusals. Private paths and provider responses are not copied into
these references. Related runs are linked explicitly; they are not presented
as one invented causal execution.

Host fixtures can supply `assessmentTransport(target)` beside their simulated
provider/runner. Real targets use admitted private kubeconfig credentials with
verified HTTPS; no browser request can supply a transport or credential. The
configuration digest now includes the assessed-deployment version, so retain
old recordings as history and create a new immutable attempt when upgrading a
host that previously ran the unassessed adapter.

The checked Neo source currently wires `seoSessions(process.env)` to SQL Server
when MSSQL is configured and otherwise to in-process memory. Its collector
SQLite files and InfluxDB are separate query data sources; the optional
PowerScale history has another local store. This deployment leaves existing
external stores untouched. Retaining infrastructure does not preserve default
in-process conversation memory across an app restart, and it is not a proof
that a SQL Server migration or collector integration was tested.

`createNeoReleasePreparation(options)` provides a separate build-only workflow. It resolves/fetches an exact source commit, builds the real Node/Python packages, publishes immutable images and seals one manifest. After `workflow.start()` passes, `prepared()` returns `{manifest,publication,buildTargetPath}`. The private publication contains the staged candidate receipt. Environment promotion consumes that result; it does not rebuild the application.

When a release catalog has resolved a reviewed source version, pass its `SourceRevision` as `expectedRevision` in `NeoReleasePreparationOptions`. The base preparation binds that exact repository/ref/commit/tree before execution and rejects a moved tag before fetch/build. For example, use `createNeoReleasePreparation({...hostOptions, expectedRevision: reviewedChoice.source})`; keep the reviewed choice in host-owned state, rather than accepting a commit from a browser request.

Existing prepared releases can also be registered explicitly. A manifest alone cannot locate private build files: its paired host publication must contain `metadata:{candidatePath,repository,commit,tree}` and exactly the same artifact identities/references. These paths never come from Lens requests.

```ts
import { createNeoReleasePipeline } from 'footprintjs-iac/integration/identity/release-pipeline';

const consumer = await createNeoReleasePipeline({
  environments: [{
    id: 'local', label: 'Local acceptance', targetPath: '/private/neo/target.json',
    promotion: 'automatic', rollback: 'disabled',
  }],
  releases: [currentPreparedRelease, nextPreparedRelease],
});
const { workflow, plans } = await consumer.createPipeline({
  id: 'reviewed-attempt-1', releaseId: nextPreparedRelease.manifest.id,
});
const state = await workflow.start();
```

Additional environments require distinct prepared targets registered by the host. The same sealed manifest and artifact bytes pass between stages. Manual promotion uses the generic pipeline's bound pending-action token. The current Lens wrapper uses the complete configured stage sequence and mandatory acceptance checks; browser controls cannot choose target paths, disable checks or advertise unsupported restore.

For every direct action the consumer reloads the canonical current target, validates the private source receipt and immutable Docker image IDs, and creates a new execution-scoped candidate bound to that current environment. An older build's `canonicalTargetSha256` is not reused as current deployment authority. A new binding preserves the sealed source/artifact identities. The existing master workflow reviews the actual resource diff and permits only no-ops/verifications plus an update of `neo-app`. Existing directory, identity provider, namespace, policy and service resources are not replaced by an application release. Publication of new canonical bindings follows the master's proven native application result.

Actual release observation reads the owned Deployment, ReplicaSet and ready Pod. It checks namespace/owner/selector, observed generation and readiness, both exact image references and runtime container image identities. Docker's artifact ID can identify an OCI index/manifest while CRI reports a config digest. `neoImageConfigDigest` verifies the sealed Docker ID, reads that immutable image archive's `manifest.json` and Config content hash, and privately caches the attestation. The temporary archive is removed. CRI config IDs, tags and reported Pod image IDs must agree with that attested mapping. Raw configuration and archive contents never enter pipeline scope. Unknown, unready, drifted or ambiguous registered release mappings stay unknown; the observer never reports a request's desired digest as measured fact.

After deployment, the registered native acceptance runner checks the actual deployed release again, runs all three real connection probes and all seven Neo login/access checks, and retains their FootPrint recordings. Expected denied access is a passing assertion only when the real policy rejects it. Native connection/access observations are forwarded through the existing `NeoDeliveryObservation` subscription, so Lens can show current system state and open the underlying measured recordings. Application internals require the application's own traces; infrastructure recording does not invent them.

The consumer returns `{target,directory,baseline,environments,baselines,suite,registry,listReleases,createPipeline,subscribe}`. `createPipeline` returns `{workflow,plans}` using the generic workflow port and pure compiled rollout plans. The current system/native projection can subscribe with the same observer interface as the older GitHub delivery consumer. Release preparation, release pipelines and the GitHub delivery consumer share a local delivery lock. Older deploy/resource-flow CLIs use lower engine locks and must not operate on the same target concurrently with this host. Shared multi-host ownership requires a transactional distributed store.

Focused tests use real native workflows and explicitly simulated provider/transport fixtures to verify repeated immutable v1 → v2 → v1 → v2 updates, one-resource diffs, all ten checks, preserved access failures, source/artifact substitution rejection, ownership/readiness/runtime drift, ambiguous manifest rejection and no rebuild during promotion. These tests do not claim a real Neo deployment; a separately selected local target is used for live acceptance. No CI, automatic source pushes, new clusters or production mutations are performed by creating this module.

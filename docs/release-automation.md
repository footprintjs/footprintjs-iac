# Published versions to an environment pipeline

`footprint-iac/release-automation/node` composes the existing read-only release
catalog, exact-source build workflow and environment pipeline. The core has no
GitHub or Neo switch. `GitHubReleaseCatalog` is one catalog adapter; a host can
register another source without changing orchestration. A release discovered in
GitHub is source metadata, not a built or verified application package.

```ts
const host = new ReleaseAutomationHost({
  definition: {
    version: 1, id: 'app-releases', label: 'App updates',
    catalogId: catalog.id, adapterId: adapter.id,
    configurationDigest: reviewedHostSettingsDigest,
    automatic: { enabled: true, initial: 'observe' },
  },
  catalog, adapter,
  store: new FileReleaseAutomationStore(privateHostDirectory),
});

await host.tick(); // First poll observes existing versions without deploying backlog.
await host.refresh(); // Discover only; no build or deployment.
await host.start(registeredReleaseId); // Manual choice of a discovered ID.
```

The host implements `ReleaseAutomationPort`: `snapshot`, `refresh`, `tick`,
`start`, `promote`, `recover` and `subscribe`. Constructor execution starts no
poller. An operating host must explicitly call finite `tick()` operations on its
own schedule. GitHub Actions, public webhook listeners and CI are not required
or started. Polling timers schedule real work; they never manufacture deployment
or readiness progress.

The adapter factories receive a resolved source and a host-owned context with
`attemptId`, `definitionDigest` and a deterministic private attempt directory.
`prepare()` returns a `ReleasePreparationPort`; `pipeline()` returns a
`PipelineWorkflowPort` for the exact passed preparation. Factories reconstruct
their child workflow and must not deploy during construction. Preparation must
bind `expectedRevision` to the catalog's repository/ref/commit/tree. The host
independently admits the preparation's source, sealed manifest and native build
receipt before starting the pipeline. The pipeline consumes that same manifest
across its configured stages. Its promotion, recovery, checks and preflight
behavior remain the responsibility of the registered deployment adapters.

The native coordinator records discovery, selection, exact-source resolution,
build initiation and pipeline initiation as separate stages. Child build and
pipeline runs retain their own native receipts. Receipt links identify real
separate runs; no invented causal edge is added between them. Use
`loadReleaseAutomationRecording()` to replay the coordinator without invoking
an adapter.

## Automatic selection and retained outcomes

The default `latestPublishedReleaseStrategy()` selects the newest eligible
published date, with a stable ID tie-breaker. It does not infer version ordering
from arbitrary labels. A host may register a different pure selection strategy;
it can select only an eligible registered ID. Choices without publication dates
remain manually selectable but are not automatically ordered by this strategy.

`initial: 'observe'` prevents deployment of the existing release backlog. After
that baseline, newly observed releases can initiate work. `initial: 'latest'`
explicitly opts into deploying the latest version at first poll. Automatic mode
is an immutable host setting, not a browser request. Source identities are
deduplicated by repository/commit/tree, so a second tag for already attempted
content cannot silently rebuild or redeploy it under the same host settings.

One active, gated or uncertain attempt blocks later starts. Known failures stop
automatic promotion and automatic newer releases. A human can initiate a new
registered source after inspecting a known terminal failure; the old attempt
and all child evidence remain retained. The same release ID or source content
is never blindly retried. After a host interruption, retained effect intent is
shown as uncertain unless the same host instance is actively running it; no
constructor or restart reissues tools. Manual `promote`/`recover` must match the
exact current child pipeline gate and do not rebuild the package.

Private ledgers contain child workflow state and local receipt paths.
`projectReleaseAutomationState()` is the browser-safe public projection: it
omits paths, provider metadata, target scopes, raw errors and gate tokens. A Lens
server may additionally project admitted child pipeline state using its own
headless protocol. Browser requests supply registered release/attempt/stage IDs,
never repository overrides, command strings, SQL, target files or credentials.

The local store uses a filesystem process lock and atomic journal writes. This
is single-host coordination, not a distributed scheduler. History is bounded:
256 attempts, 1,000 coordinator recordings and 32 continuation recordings per
attempt. Archive and explicitly configure a new host before exhausting limits.
Absence of a running host means absence of polling or automatic deployment.

Focused tests use real native build/pipeline recordings with an explicitly
simulated provider. They cover backlog exclusion, new-release initiation,
manual deployment, alias dedupe, three ordered stages, durable approval gates,
failed and unknown outcomes, overlap refusal, changed source selectors,
unavailable discovery, replay privacy and tamper rejection. They do not claim a
live GitHub publication, production deployment or Neo database migration.

# Neo published-version automation

This consumer composes the generic release catalog, source preparation,
automation host and assessed Neo environment pipeline. Neo remains an
application consumer; none of its identity, image or kind conventions enter the
generic coordinator.

```ts
const consumer = await createNeoReleaseAutomation({
  id: 'neo-updates', directory: privateDirectory,
  configurationDigest: reviewedHostContractDigest,
  catalog: githubCatalog,
  automatic: { enabled: true, initial: 'observe' },
  environments: [
    {id:'dev', label:'Development', targetPath:devTarget, promotion:'automatic', rollback:'disabled'},
    {id:'gamma', label:'Gamma', targetPath:gammaTarget, promotion:'automatic', rollback:'disabled'},
    {id:'prod', label:'Production', targetPath:prodTarget, promotion:'manual', rollback:'disabled'},
  ],
  baselineReleases: reviewedExistingBuilds,
  sourceAdapter(choice, context) {
    return new GitSourceAdapter({
      directory: join(context.directory,'source'),
      repository: choice.source.repository, allowedRefs: [choice.source.ref],
    });
  },
});
await consumer.host.tick(); // Baseline existing published releases; no backlog deployment.
```

Each environment is a distinct already prepared healthy owned Neo target. Its
canonical absolute `target.json` is private host configuration. The first
environment is the build target. Baseline manifests/publications must identify
the actual existing image contents and source receipts; they are not invented
from a new build of the same source. Use one canonical registration for a given
build across environments. Ambiguous manifests with the same images remain
unknown rather than selecting a desired label.

`sourceAdapter` returns the normal trusted source adapter. Catalog resolution
pins repository/ref/commit/tree; preparation independently resolves that exact
source again before fetching/building. The package is built once, and all
environment stages consume the same sealed artifacts. Publication loads images
into the first local kind target; the rollout adapter loads that package into
each later target without rebuilding. No GitHub Actions or CI workflow is used.

The consumer registers all baselines and passed preparations from its private
automation ledger when reconstructing pipelines. This includes prepared code
whose later deployment failed, so actual version observation can identify that
candidate instead of assuming the baseline is still running. Source, manifest,
publication and target identity mismatches stop work. A host restart reconstructs
the same immutable build/pipeline attempt; active or uncertain effects are never
automatically retried. Outstanding manual promotion uses the exact retained
pipeline gate and does not rebuild.

Normal Neo rollouts use mandatory recorded provider preflight during plan and
revalidation before apply. Each current local adapter stage supports direct app
updates, verifies live connections plus login/access, and leaves unchanged
identity/storage/network resources managed. Replacement, unknown capability or
unsupported changes stop before applying the candidate. Database migrations
are separate explicitly supported flows.

`initialConsumer` exposes the admitted baseline/environment views for Lens.
`subscribe()` forwards real Neo assessment, deployment, connection, identity and
applied observations. `host.subscribe()` exposes generic build/pipeline state.
`consumer(attemptId)` returns an already constructed in-process Neo pipeline
consumer for that attempt, if present; it does not execute one merely to inspect
it. Browser controls call the generic host with IDs only.

The labels dev/gamma/prod do not provision remote production infrastructure or
establish any production isolation guarantee. Register three distinct owned
targets and the intended promotion policy. For unattended advancement through
all three, explicitly set all three `promotion: 'automatic'` in trusted host
configuration; gamma/prod failures still stop later promotion. The current Neo
adapter requires `rollback: 'disabled'` because it has no independently verified
restoration contract. Generic automatic/manual recovery interfaces cannot make
that capability appear. No schema reversal or data rollback is implied.

A host must explicitly schedule finite `host.tick()` calls. `refresh()` only
discovers versions; `start(releaseId)` manually initiates a discovered source.
The default automatic policy selects only new published choices after the first
baseline. Draft releases are excluded by `GitHubReleaseCatalog`. A repository
with only drafts therefore offers no published GitHub source to auto-deploy.
Do not publish a release merely to make a demonstration pass; use a clearly
labelled host-registered pinned-source catalog for a manual local acceptance.

Configuration digests bind the host contract version, recipe, baseline
manifests, fixed target identities/paths, policies and environment order. They
are not automatic attestation of arbitrary callback source code. Change the
reviewed host contract digest when changing trusted callback/adapter behavior.
See [generic automation](../../../docs/release-automation.md) and
[Neo release pipeline](../../../docs/NEO-RELEASE-PIPELINE-HANDOFF.md).

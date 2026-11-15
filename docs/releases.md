# Build once and promote the same release

`/releases` contains browser-safe data contracts and structural readers.
`/releases/node` seals and verifies manifest digests, exposes prepared catalogs,
and runs the recorded build workflow. `/releases/github` is an optional source
catalog adapter. The pipeline consumes a sealed manifest; it does not rebuild
it separately for each environment.

```ts
import { ReleasePreparationWorkflow, FileReleasePreparationStore } from 'footprintjs-iac/releases/node';

const preparation = new ReleasePreparationWorkflow({
  definition: {
    id: 'app-v2', label: 'Application v2',
    source: { repository: 'https://github.com/company/app.git', ref: 'refs/tags/v2' },
    recipe: { id: 'application-package', digest: recipeDigest },
    target: { id: 'build-host', scope: 'approved-artifact-store' },
    configurationDigest: hostConfigurationDigest,
  },
  store: new FileReleasePreparationStore(privateAttemptDirectory),
  adapters: { source: sourceAdapter, build: buildAdapter, artifacts: artifactStore },
});
const prepared = await preparation.start();
if (prepared.status !== 'passed') throw new Error('Inspect retained build evidence');
// Pass prepared.release to PipelineWorkflow for every configured environment.
```

The native chart has four real stages: resolve exact source, fetch, build,
publish. Every adapter call follows a durable recorded intent. Source identity,
build recipe and published content must agree. Reopening a successful attempt
validates its retained native evidence and replays its result without repeating
the build. Failed or uncertain attempts require inspection and a new explicit
attempt; this local store does not guess whether an external effect happened.

The immutable manifest binds the full source commit/tree, recipe and artifact
digests/references. It contains no checkout path, credentials or deployment
handles. A local repository becomes an opaque source identity, also accepted by
the versioned master without retaining that path. The private
attempt ledger retains host locations and adapter metadata; native recordings
contain safe allowlisted summaries. Keep private ledgers outside any web root.
Artifact publication/storage remains the configured adapter's responsibility.
Sealing a digest does not by itself establish that an external registry is
immutable or that a build was reproducible.

## GitHub discovery is not a built release

```ts
import { GitHubReleaseCatalog } from 'footprintjs-iac/releases/github';
const catalog = new GitHubReleaseCatalog({
  id: 'app-github', repository: 'company/app',
  token: async () => secretStore.read('github-read-token'),
});
const choices = await catalog.list();
const selected = await catalog.resolve(choices[0]!.id);
// Set expectedRevision: selected.source on ReleasePreparationWorkflow.
```

Only published GitHub releases appear, with prereleases opt-in. Drafts never
appear. Pagination is bounded; inspect `catalog.truncated` if the configured
limit can hide older releases. This adapter lists releases, not every Git tag.
It resolves lightweight/annotated tags to a full commit and tree and pins the
result until the next catalog refresh. Git references may move before initial
resolution; review the resolved commit before starting a build. Set the build's
`expectedRevision` to that resolved source: the durable binding includes it and
a moved tag fails before fetch/build. The source adapter must acquire that exact
revision. The source catalog does not
download release assets, run repository commands, trigger CI or deploy anything.

Only registered release IDs cross the browser boundary. Repository, API/clone
roots, token provider and transport belong to the trusted composition root.
REST calls use GET with redirect refusal, bounded responses and deadlines;
errors omit response bodies and transport/credential details. Enterprise hosts
must configure both API and web roots explicitly. Credentials must never be
embedded in URLs or manifests.

The GitHub adapter follows the official [release API](https://docs.github.com/en/rest/releases/releases),
[references API](https://docs.github.com/en/rest/git/refs),
[annotated tag API](https://docs.github.com/en/rest/git/tags), and
[Git commit API](https://docs.github.com/en/rest/git/commits).

## Change and data boundaries

The existing resource planner compares desired and observed fingerprints and
produces create/update/verify/delete/noop operations. Unsupported physical
identity changes and Kubernetes field removals fail before mutation rather than
silently replacing or orphaning resources. Provider scope and ownership remain
checked. The delivery bridge can carry those actual reviewed changes into the
pipeline's native recording and Lens.

The separate opt-in [change assessment](change-assessment.md) workflow records
provider reads/validation and classifies a proposed change before an executor
acts. A real Kubernetes read-only check distinguished an image update from an
immutable-selector replacement requirement while preserving UID, resourceVersion
and spec. An assessment report is point-in-time evidence, not permission to
delete/recreate a resource or a promise of later execution success.

An application rollback is not a database restore. The opt-in
[guarded migration workflow](migration.md) now provides separate adapter ports
for quiescing writes, backing up, creating/transferring/verifying a replacement,
human cutover, consumer verification and retention. The backup proof binds its
independently measured source snapshot; source, backup and replacement are
revalidated before cutover. This API never deletes those data artifacts.

The [SQLite adapter](sqlite-migration.md) exercises real full-record preservation
and pointer switching for a cooperating single-host consumer. It does not
migrate Neo's current database, implement distributed writers or automatically
reverse schema changes and new writes. Resource reconciliation still infers no
automatic data migration or destructive replacement. Each registered adapter
must establish its supported operations and actual data/consumer proofs; a
package digest alone cannot establish recovery safety.

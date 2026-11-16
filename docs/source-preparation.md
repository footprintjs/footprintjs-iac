# Prepare source before deployment review

`SourcePreparationWorkflow` acquires and packages one exact application version
before a separate deployment review. The recorded native chart is:

**Choose exact version → Get code → Build package → Store package**

It stops after artifact publication. A caller can then build the target graph,
inspect the existing system, seal a review, and explicitly apply that review
through its normal deployment interface. Preparation never reports deployment
or application verification stages that did not run. `DeliveryWorkflow` remains
available when the host deliberately owns all seven delivery stages.

Source and release preparation share one private four-stage chart and native
execution kernel. The source API retains its target-bound receipt identity;
release preparation retains its sealed manifest for build-once promotion.
Their public state/evidence kinds and historic recordings remain unchanged.

## Public interfaces

```ts
import {createGitHubSourceAdapter} from 'footprintjs-iac/delivery/git';
import {
  SourcePreparationWorkflow,
  FileSourcePreparationStore,
} from 'footprintjs-iac/source-preparation/node';

const source = createGitHubSourceAdapter({
  repository: 'company/application',
  allowedRefs: ['release/reviewed'],
  directory: privateSourceCache,
});
const preparation = new SourcePreparationWorkflow({
  definition: {
    id: 'application-reviewed-version',
    label: 'Application source',
    source: {repository: source.repository, ref: 'release/reviewed'},
    target: registeredTarget,
    recipe: registeredRecipe,
    configurationDigest: reviewedHostConfigurationDigest,
    // Optional: bind a version already selected by a release catalog.
    expectedRevision: selectedExactRevision,
  },
  store: new FileSourcePreparationStore(privateAttemptDirectory),
  adapters: {source, build: registeredBuildAdapter, artifacts: registeredArtifactStore},
});
const stop = preparation.subscribe(state => publishSafeSourceView(state));
const prepared = await preparation.start();
stop();
if (prepared.status === 'passed') {
  // Trusted composition consumes exact private receipts, then asks the normal
  // deployment host to inspect/review/apply. No target mutation happened above.
  await prepareReview(prepared.results, prepared.recordings);
}
```

The browser-safe `footprintjs-iac/source-preparation` entrypoint exports the
definition, adapter/state types, strict admission readers and
`sourcePreparationReceiptDigest(passedState)`. After native admission, this
digest binds the exact revision, published artifact identities, recipe,
execution and native run in addition to the definition digest. Use it when a
deployment review or agent graph needs to name this prepared source result;
the definition digest alone does not distinguish new runs of a mutable ref.
Computing the hash is pure and does not itself validate native evidence files.
Host execution,
private storage and native evidence loading live in `/source-preparation/node`.
The adapters reuse `SourceAdapter`, `BuildAdapter` and `ArtifactStore`; GitHub,
other Git hosts and local Git sources remain independent of systemd, Kubernetes
or another deployment strategy. GitHub Actions is not required or dispatched.

## Immutable intent and retained outcomes

Each private directory represents one immutable preparation attempt. The full
definition digest binds source/ref, recipe, configuration, target and optional
expected commit/tree. Resolve freezes the exact commit/tree; fetch must return
that version. Build must use the bound recipe, and publication must preserve
the built artifact names and content digests. A supplied `expectedRevision`
must match the adapter's exact repository, ref, commit and tree.

The host writes and syncs stage intent before invoking each adapter. Concurrent
starts cannot share the same store lock. Completed preparation is read-only and
can be reopened without fetching, rebuilding or publishing again. Failed or
uncertain attempts are retained and cannot be retried through `start()`.
A different host reading an unfinished run reports `incomplete`, rather than
claiming that the original process remains active. Inspect the actual Git/build
outcome and create a newly bound attempt after trusted reconciliation.

Native FootPrint execution uses full read tracking, reads-prefix provenance and
the file recorder. Four actual stage events drive progress; no UI timer creates
readiness. The JSON snapshot and complete JSONL replay must agree before a
retained passed result is admitted. Changed source, target, recipe, definition,
receipt, progress events, native run or missing trace rejects admission.
`loadSourcePreparationRecording(path, expected)` checks those native run binding
fields and the complete trace without running any adapter.

Source locations and opaque build metadata stay in the host's private ledger.
Native evidence contains public source version identities, recipe/content
digests and artifact references. Adapters must supply credential-free public
artifact identities; store private filesystem handles in omitted metadata.
Project only an explicit safe DTO to Lens. Git credentials stay on the trusted
host, outside graph JSON and browser requests.

Preparation proves the recorded source/package work. It does not prove that a
build is reproducible, that the package is production-ready, or that an agent
has a separate sandbox. Deployment preflight, sealed review, provider effects
and component verification keep their own recorded workflows and receipt links.

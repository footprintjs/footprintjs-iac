# Rahul's agent: reproduce the Neo release pipeline locally

**Distribution status:** this document describes the current review candidate. The latest core and Lens changes are still in working copies; they have **not yet been pushed or published**. The repository URLs below identify the projects, not a claim that a fresh clone already contains this feature. Obtain the owner's reviewed working-copy bundle or the exact core/Lens commit hashes after they are pushed. Record the bundle SHA-256 and both checkout revisions. Do not publish, push, merge, dispatch GitHub Actions or enable CI as part of this reproduction.

- Base library: [footprintjs/footprintjs-iac](https://github.com/footprintjs/footprintjs-iac).
- Dashboard: [footprintjs/footprintjs-iac-lens](https://github.com/footprintjs/footprintjs-iac-lens).
- Real consumer: [sanjay1909/neo-agentfootprint](https://github.com/sanjay1909/neo-agentfootprint).

Use your own repository permissions and Git credential helper. Tokens do not belong in clone URLs, manifests, browser inputs or forwarded files. Keep the core and Lens as sibling directories because Lens depends on `file:../footprint-iac`. Keep private host JSON, target descriptors, credentials, caches and evidence on this laptop; another laptop's localhost URL or `.artifacts/` directory is not a deployable package.

## 1. Check the received candidate

Requirements are Node.js 24+, npm, Git, a running Linux Docker engine, kind, kubectl, OpenSSL, tar and a POSIX shell with `ps`. Initial builds need GitHub, npm, Python and container registry access. Check Docker VM capacity before adding a cluster; preserve unrelated targets and running apps.

```sh
node --version
npm --version
git --version
docker info
kind version
kubectl version --client
openssl version
tar --version
```

Use new clean checkouts or the supplied bundle; preserve existing edits. After applying the reviewed candidate, require these files to exist:

```sh
test -f footprint-iac/integration/identity/release-pipeline/index.ts
test -f footprint-iac/src/releases/preparation.ts
test -f footprint-iac-lens/examples/neo-release-pipeline.ts
```

For Git checkouts, record `git -C footprint-iac rev-parse HEAD` and the matching
Lens revision, plus their working-copy differences. A portable candidate bundle
deliberately omits Git metadata and all runtime/private files; verify its
`SHA256SUMS` and `bundle-provenance.json` instead. Then run the real local gates, core first:

```sh
cd footprint-iac
npm ci
npm run check
npm test
npm run build
cd ../footprint-iac-lens
npm ci
npm run check
npm test
npm run build
cd ../footprint-iac
```

The focused core files are `test/check-runner.test.ts`, `test/trigger-dispatcher.test.ts`, `test/pipeline.test.ts`, `test/releases.test.ts` and `test/neo-release-pipeline.test.ts`. Their simulated provider/transport cases do not replace the live acceptance below. Neo's own application gate is separate: read its `AGENTS.md`, `CLAUDE.md` and `docs/LOCAL_DEV.md` and report its actual checks and any unavailable dependencies. Do not invent a replacement Neo development startup script.

## 2. Select or create this laptop's baseline

The release consumer upgrades an **existing healthy Neo identity deployment**. It requires a canonical `target.json`, a successful native `deployment.json` and retained source/build receipts for the actual current images. Do not point it at an empty cluster and claim the release pipeline created the initial six resources.

If this laptop already has a suitable owned target, pin its canonical absolute `target.json` path as `IAC_TARGET`. Confirm its exact context/namespace and preserve its private fixture files. Use an explicitly disposable test target; do not substitute an ordinary developer or production cluster.

For a fresh local fixture, follow the [identity integration guide](../integration/identity/README.md) and [portable Create/Find handoff](NEO-RESOURCE-FLOW-HANDOFF.md). The following uses their known source commits: `6f876df846ae683cc9e9a114a51b638e31615af2` only prepares the empty cluster, `7f5e4546bfcc0f4586e641ab19375c43238165a8` supplies the protected baseline, and `839f6fd726607eb742e76374b94ab8733ef99be2` supplies the visible v2 application update. These are application source pins, not hashes for the unpushed library candidate.

From the directory containing the sibling core/Lens checkouts:

```sh
git clone --branch demo/neo-master-upgrade-v2-20261111 https://github.com/sanjay1909/neo-agentfootprint.git neo-agentfootprint-v2
git -C neo-agentfootprint-v2 switch --detach 839f6fd726607eb742e76374b94ab8733ef99be2
git -C neo-agentfootprint-v2 worktree add --detach ../neo-agentfootprint-baseline 7f5e4546bfcc0f4586e641ab19375c43238165a8
git -C neo-agentfootprint-v2 worktree add --detach ../neo-agentfootprint-base-fixture 6f876df846ae683cc9e9a114a51b638e31615af2
cd footprint-iac
npm run neo:prepare-fresh -- ../neo-agentfootprint-base-fixture
npm run identity:prepare -- .artifacts/neo/fresh/latest.json
export IAC_TARGET="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; import {join} from "node:path"; const t=JSON.parse(readFileSync(".artifacts/identity/latest.json","utf8")); console.log(join(t.directory,"target.json"));')"
NEO_BASELINE_TREE="$(git -C ../neo-agentfootprint-baseline rev-parse 'HEAD^{tree}')"
node integration/identity/build-neo.ts ../neo-agentfootprint-baseline "$NEO_BASELINE_TREE" "$IAC_TARGET"
npm run identity:deploy -- "$IAC_TARGET"
node integration/identity/forward.ts "$IAC_TARGET"
npm run identity:verify -- "$IAC_TARGET"
```

These are explicit baseline bootstrap operations. `neo:prepare-fresh` prepares an empty isolated kind cluster; `identity:prepare` generates private identity fixtures and chooses local ports; the protected image build pins its source and recipe; `identity:deploy` performs the actual six-resource baseline apply. Check every exit status and retain the resulting evidence. Alternatively, use the documented one-build identity Lens viewer for that initial creation, then return here with its successful baseline. Pin `IAC_TARGET` after preparation and use that exact value in every terminal; do not follow a later `latest.json` silently.

The target chooses its own Neo URL. Read it from the forward output or target descriptor. Alice is the allowed local reader and Bob is the denied guest; retrieve generated passwords privately from this target's `credentials.json` and never share that file.

## 3. Build once, seal, and create private host configuration

The host registers the current release as well as the candidate. Actual observation must identify the running baseline before it can authorize an update. A new build of the same source can have different image IDs; **never assume `prepared()` describes the already running images**.

Prefer a retained passed release preparation for the baseline. A passed older seven-stage `DeliveryWorkflow` is also usable as an explicit imported baseline: its revision, recipe, publication and native receipt establish the prior build. If neither exists, the script below imports the existing local build's own matching `source-review.json`, verifies its packaging hashes and stages a private receipt through the existing fixture helper. That fallback is an **imported build receipt**, not a newly recorded four-stage release build or proof of the full application gate. Missing/mismatched source or recipe evidence must stop the import.

Create the following **local host script** as `footprint-iac/examples/prepare-neo-release-host.mjs`. It belongs to this reproduction's host composition, not the Neo application repository. It uses the public release/preparation contracts; the direct import of `stageNeoCandidate` is the existing local fixture staging helper, not a generic production provisioning API.

```js
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readDeliveryState} from 'footprintjs-iac/delivery';
import {loadDeliveryRecording} from 'footprintjs-iac/delivery/workflow';
import {GitSourceAdapter} from 'footprintjs-iac/delivery/git';
import {defineReleaseManifest} from 'footprintjs-iac/releases/node';
import {loadIdentityTarget, identityRoot} from 'footprintjs-iac/integration/identity';
import {neoDeliveryArtifacts, neoDeliveryRecipe} from 'footprintjs-iac/integration/identity/github-delivery';
import {createNeoReleasePreparation} from 'footprintjs-iac/integration/identity/release-pipeline';
import {stageNeoCandidate} from '../integration/identity/stage-neo-candidate.ts';

const [targetArgument, checkoutArgument, hostArgument, priorDeliveryArgument] = process.argv.slice(2);
if (!targetArgument || !checkoutArgument || !hostArgument)
  throw Error('Usage: node examples/prepare-neo-release-host.mjs TARGET NEXT_CHECKOUT HOST_JSON [PASSED_DELIVERY_JSON]');
const targetPath = resolve(targetArgument), checkout = resolve(checkoutArgument);
const hostPath = resolve(hostArgument), target = await loadIdentityTarget(targetPath);
assert.equal(targetPath, join(target.directory, 'target.json'));
const repository = 'https://github.com/sanjay1909/neo-agentfootprint.git';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const artifactIdentity = artifacts => JSON.stringify([...artifacts]
  .map(({id,digest,reference}) => ({id,digest,reference})).sort((a,b) => a.id.localeCompare(b.id)));
const actualArtifacts = neoDeliveryArtifacts(target);
let current;

if (priorDeliveryArgument) {
  const old = readDeliveryState(await readJson(resolve(priorDeliveryArgument)));
  assert.equal(old.status, 'passed');
  assert.ok(old.results.revision && old.results.publication && old.executionId);
  assert.equal(old.results.revision.commit, target.sourceCommit);
  assert.equal(artifactIdentity(old.results.publication.artifacts), artifactIdentity(actualArtifacts));
  const receipt = old.recordings.find(item => item.status === 'passed');
  assert.ok(receipt);
  await loadDeliveryRecording(receipt.evidencePath, {
    runId: receipt.runId, definitionDigest: old.definitionDigest, executionId: old.executionId,
  });
  current = {
    manifest: defineReleaseManifest({
      id: 'imported-current-' + target.id, label: 'Current Neo baseline',
      source: old.results.revision, recipe: old.definition.recipe, artifacts: actualArtifacts,
    }),
    publication: old.results.publication, buildTargetPath: targetPath,
  };
} else {
  const review = await readJson(join(target.directory, 'source-review.json'));
  assert.equal(review.sourceStatus, 'committed-clean');
  assert.equal(review.baseCommit, target.sourceCommit);
  assert.match(review.sourceTree, /^[a-f0-9]{40}$/);
  assert.equal(review.image, target.images.nodeImage);
  assert.equal(review.pythonImage, target.images.pythonImage);
  assert.equal(review.imageId, 'sha256:' + actualArtifacts.find(item => item.id === 'node').digest);
  assert.equal(review.pythonImageId, 'sha256:' + actualArtifacts.find(item => item.id === 'python').digest);
  assert.ok(target.sourceDirectory);
  const origin = execFileSync('git', ['-C', target.sourceDirectory,
    'remote', 'get-url', 'origin'], {encoding:'utf8'}).trim();
  if (origin.replace(/\.git$/, '') !== repository.replace(/\.git$/, ''))
    throw Error('Baseline source origin differs from this reviewed Neo repository');
  const recordedTree = execFileSync('git', ['-C', target.sourceDirectory,
    'rev-parse', review.baseCommit + '^{tree}'], {encoding:'utf8'}).trim();
  assert.equal(recordedTree, review.sourceTree);
  const coreRoot = fileURLToPath(new URL('../', import.meta.url));
  for (const file of ['Node.Dockerfile', 'Python.Dockerfile', 'start-sidecar.py']) {
    const hash = createHash('sha256').update(await readFile(join(coreRoot, 'integration/neo', file))).digest('hex');
    assert.equal(review.packaging?.[file], hash, 'Retain the exact original packaging recipe');
  }
  const source = {repository, ref: review.baseCommit, commit: review.baseCommit, tree: review.sourceTree};
  const manifest = defineReleaseManifest({id:'imported-current-' + target.id,
    label:'Imported current Neo build', source, recipe:await neoDeliveryRecipe(), artifacts:actualArtifacts});
  const canonicalBytes = await readFile(targetPath, 'utf8');
  const candidatePath = await stageNeoCandidate(target, review.sourceTree, review,
    canonicalBytes, identityRoot, 'baseline-import-' + randomUUID());
  current = {manifest, buildTargetPath:targetPath, publication:{artifacts:actualArtifacts,
    metadata:{candidatePath, repository, commit:source.commit, tree:source.tree}}};
  console.log('Baseline imported from its prior local build receipt; no new native build proof is claimed.');
}

// This trusted checkout is a reviewed source choice. A resolved GitHub catalog choice
// can instead supply its exact selected.source, including its ref, as expectedRevision.
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {encoding:'utf8'}).trim();
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
assert.match(commit, /^[a-f0-9]{40}$/);
assert.match(tree, /^[a-f0-9]{40}$/);
const expectedRevision = {repository, ref:commit, commit, tree};
const sourceAdapter = new GitSourceAdapter({directory:join(target.directory,'release-source-cache'),
  repository, allowedRefs:[expectedRevision.ref]});
const preparation = await createNeoReleasePreparation({
  id:'neo-next-' + commit.slice(0,12) + '-' + randomUUID().slice(0,8),
  targetPath, source:{repository,ref:expectedRevision.ref}, sourceAdapter, expectedRevision,
});
const built = await preparation.workflow.start();
assert.equal(built.status, 'passed', 'Inspect retained build evidence on failure; do not force a retry');
const next = await preparation.prepared();
assert.notEqual(artifactIdentity(next.manifest.artifacts), artifactIdentity(actualArtifacts),
  'Choose a reviewed release with changed application artifacts for an actual upgrade');
const host = {id:'neo-local-release-review',
  directory:join(target.directory,'release-pipelines','local-review-' + randomUUID()),
  environments:[{id:'local',label:'Local acceptance',targetPath,promotion:'automatic',rollback:'disabled'}],
  releases:[current,next]};
await mkdir(dirname(hostPath), {recursive:true,mode:0o700});
await writeFile(hostPath, JSON.stringify(host,null,2) + '\n', {flag:'wx',mode:0o600});
console.log(JSON.stringify({hostPath, currentReleaseId:current.manifest.id,
  nextReleaseId:next.manifest.id, nextCommit:next.manifest.source.commit},null,2));
```

From the core checkout, choose a new private output filename and run it:

```sh
export IAC_HOST_CONFIG="$PWD/.artifacts/neo-release-host.json"
node examples/prepare-neo-release-host.mjs "$IAC_TARGET" ../neo-agentfootprint-v2 "$IAC_HOST_CONFIG"
```

If available, append the path to this target's passed older `delivery.json` to import that proven publication instead of the local build-receipt fallback. If a passed release preparation already matches the current images, use its `prepared()` output as `current` in the host composition instead. Do not rewrite a receipt, target image reference or manifest digest to make a mismatched build appear current.

Review the exact next commit/tree before running the build. With `GitHubReleaseCatalog`, first resolve the selected registered source choice and pass `selected.source` as `expectedRevision`; keep its repository/ref/commit/tree together. A moved tag fails before fetch/build. Source discovery alone is not a built release. The normal preparation builds real Neo images; it can take time and requires Docker capacity. It does not deploy the candidate or change canonical app bindings.

## 4. Preview and deploy manually in Lens

In a terminal with the same absolute `IAC_HOST_CONFIG`, run from the Lens checkout:

```sh
node examples/neo-release-pipeline.ts "$IAC_HOST_CONFIG" --port=0
```

Open the printed loopback URL. Starting the host admits the baseline and opens the dashboard; it does not start the candidate deployment. Choose the printed **next** prepared release ID, press **Preview**, inspect the exact version and configured environment, then press **Start deployment** once. This consumer exposes **Direct update**, mandatory acceptance checks and `rollback: disabled`. The host's single local stage runs automatically after that explicit start; separately configured manual stages require promotion.

This Neo screen currently lists host-registered **prepared releases**. GitHub source discovery and the four-stage source/build/publication workflow happen in the trusted preparation step above; this screen does not automatically discover every GitHub release or build a selected source choice.

Require:

1. The pipeline chart follows native recorded stages and operations. Configuration preview must not appear as executed history.
2. A genuine application upgrade changes only `neo-app`; unchanged directory, provider, namespace, policy and service resources remain managed. This is an update of an existing system, not six fresh creates.
3. The system/resource view retains actual deployment observations. Three connection edges run checking → connected/failed from real probes; seven identity/access assertions follow. Colours or timers are not evidence of readiness.
4. The environment's native recording opens from its pipeline details. Resource, connection and identity panels retain their own recordings; independently recorded runs are not joined with invented causal edges.
5. The final release, source commit and artifacts match the prepared manifest. Actual observation verifies owned Kubernetes objects, readiness and attested runtime image content. Unknown or ambiguous version identity must stop the run.

The three checks are broker→directory authentication, Neo→provider signing keys, and Service→Neo HTTP routing. The seven assertions are directory availability, Alice login, wrong-password rejection, anonymous refusal, reader allowed, signed-in guest denied and forged-token refusal. Expected denials pass only when the actual response matches the expected rejection. An unavailable service cannot substitute for a correct denial.

Use **Open Neo** and its generated URL; sign in as Alice and exercise the protected application, then verify Bob is denied. The local demo uses seeded/scripted application behavior where documented; this is not a live model or collector acceptance claim. Credentials stay local.

Restarting the same Lens command reloads the retained attempt for inspection or an outstanding explicit gate. It must not repeat completed provider effects. For a separately reviewed new attempt, stop that host and restart with `--new-attempt`; press Preview again. This creates a new immutable attempt pointer while retaining prior evidence. It is not arbitrary stage resume and does not clear uncertainty or reset deployment inventory.

## 5. Record real failure and recovery without hiding the failed run

Do not run old deploy/resource-flow/fault CLIs concurrently with an active release operation. Release preparation, release pipelines and GitHub delivery share their local delivery lock; older entry points have only lower engine locks. Wait for the attempt to be terminal or idle before the scoped fault below.

For an explicit disposable-target experiment, stop the directory while no release operation is running:

```sh
npm run identity:fault -- directory-down "$IAC_TARGET"
```

Record all ten real point-in-time checks from the core checkout with a small one-off host invocation:

```sh
node --input-type=module - "$IAC_TARGET" <<'JS'
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {loadIdentityTarget} from 'footprintjs-iac/integration/identity';
import {verifyNeoResourceFlow} from './integration/identity/resource-flow-verify.ts';
const target=await loadIdentityTarget(process.argv[2]);
const directory=join(target.directory,'release-check-experiments',randomUUID());
const result=await verifyNeoResourceFlow(target,directory);
console.log(JSON.stringify({ok:result.ok,checks:result.checks,receipts:result.receipts},null,2));
if(!result.ok)process.exitCode=1;
JS
```

Expect a nonzero result for the outage. Retain its receipts: broker→directory and fresh-login assertions should fail while independent paths can still succeed. These are real failed **check runs**, not a claimed completed pipeline or continuous monitoring service.

The one-off invocation stores independent native recordings; the current Neo Lens host does not automatically import external CLI check runs into its live view. Inspect each printed receipt with the core's read-only `npm run iac -- replay /the/printed/evidence.json` or `inspect` command. The deployment's own acceptance runner publishes its three connection and seven access observations live in Lens.

If you Preview/Start the prepared update during this retained outage, the selective plan may reject it **before application deployment/checks**, because an app release is forbidden from repairing the stopped identity resource. Preserve that failed attempt and report which stage actually ran; do not claim ten pipeline assertions executed when they were skipped. A deliberately faulty application release that stays ready but fails access checks is a separate reviewed test input; no such remote branch is assumed here.

After the failure is terminal, restore the scoped fault, including after a failed assertion:

```sh
npm run identity:fault -- restore "$IAC_TARGET"
npm run identity:verify -- "$IAC_TARGET"
```

Repeat the one-off ten-check invocation above and retain its successful recovery receipts. Then start Lens with the same private host file and `--new-attempt`, select the prepared next release and Preview/Start again. This is a **new immutable release attempt**, not a retry that erases failure. If the earlier attempt failed before applying the app, this run should perform the real app update and finish all ten checks. If the actual app version already changed, first inspect it; a no-op is a no-op and must be reported as such. To deploy a different version, prepare/register another reviewed release or explicitly select a registered previous release as a new application deployment after checking data compatibility.

Fault restoration is an explicit fixture operation. It is not the pipeline's automatic rollback feature. This Neo consumer has rollback disabled and does not reverse database migrations or application writes.

## 6. Evidence and limits to report

Report the received bundle/commit identities, actual checks/builds, chosen target context/namespace, prepared source commit/tree, manifest/artifact IDs, changed resources, all three connection and seven access outcomes, failure stage, recovery attempt and retained native receipt locations. Keep private credentials/host files out of screenshots, artifacts and commits. Replay/inspection is read-only; do not invoke a provider merely to view saved evidence.

Current acceptance uses one existing local environment with direct application updates. The generic library has other strategy interfaces, checks and trigger adapters, but this Neo adapter does not implement real traffic canaries, blue-green routing, production hosting, automatic restoration, cross-host ownership or data migration. Optional Playwright support requires a host-registered installed CLI/suite; parser tests do not mean a browser was run. The current Neo Lens catalog offers no schedule controls. Generic scheduled monitoring requires a scheduler host to call `TriggerDispatcher.tick()` and retain its native check runs; configuring an interval alone starts no monitoring, deployment or rollback.

See [Neo consumer contracts](../integration/identity/release-pipeline/README.md), [release manifests](releases.md), [release strategies](release-strategies.md), [checks and triggers](checks-and-triggers.md), and Lens's `docs/pipeline-strategies.md` in the sibling checkout. Keep CI off and review the full working-copy changes and measured evidence before any separately authorized publish or merge.

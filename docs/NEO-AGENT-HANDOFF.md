# Reproduce fresh Neo deployment, connection failures and recovery

Run this on the receiving laptop. Generate its own target, ports, image identities
and credentials. Another laptop's localhost URL or Docker cache is not a dependency.

Repositories:

- IaC: https://github.com/footprintjs/footprintjs-iac
- Lens: https://github.com/footprintjs/footprintjs-iac-lens
- Consumer: https://github.com/sanjay1909/neo-agentfootprint
- Detailed contract: [identity integration](../integration/identity/README.md)

Use the exact IaC/Lens commit hashes in the accompanying message when supplied;
otherwise record the actual `main` hashes. The protected consumer is Neo
`7f5e4546bfcc0f4586e641ab19375c43238165a8` on
`feat/neo-identity-ldap-20261110`. The older preparation fixture below is separate
from that protected consumer. It supplies the known base preparation route;
this is not a claim that fresh preparation rejects every other Neo revision.

Run checks, builds and tests directly locally. Do not dispatch GitHub Actions,
open a PR to trigger checks, or enable CI. This requests reproduction, not a push
or a rewrite of another developer's Neo work.

## 1. Separate checkouts and local checks

Requirements: a POSIX shell (macOS, Linux or WSL), Node.js 24+, npm, Git, a running
Linux Docker engine, kind, kubectl, OpenSSL and tar on PATH. Initial builds need
GitHub, container-registry, npm and Python-registry access. Confirm read access
to all three repositories; report a missing repository rather than requesting
someone else's credentials or private fixture files.

Choose a new empty parent folder. Preserve existing checkouts and dirty work:

```sh
mkdir neo-iac-review
cd neo-iac-review
git clone https://github.com/footprintjs/footprintjs-iac.git footprint-iac
git clone https://github.com/footprintjs/footprintjs-iac-lens.git footprint-iac-lens
git clone --branch feat/neo-identity-ldap-20261110 https://github.com/sanjay1909/neo-agentfootprint.git neo-agentfootprint-identity
git -C neo-agentfootprint-identity switch --detach 7f5e4546bfcc0f4586e641ab19375c43238165a8
git -C neo-agentfootprint-identity worktree add --detach ../neo-agentfootprint-base-fixture 6f876df846ae683cc9e9a114a51b638e31615af2
```

Detach the two new IaC/Lens checkouts at the supplied hashes now if the forwarding
message provides pins. Do not reset or clean an existing working tree. Fetch a
missing pinned commit from its own origin if a shallow clone lacks it. Sibling
names matter: Lens currently uses `file:../footprint-iac`.

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

Record actual counts and failures. Building an image is not the full Neo gate.
To run Neo's separate `npm run check`, first follow its AGENTS.md, CLAUDE.md and
native dependency setup. Do not invent a second development workflow or report
the full consumer gate as passed merely because this integration passes.

## 2. Prepare an empty target and build the protected consumer

Check Docker VM memory before creating another cluster. Preserve unrelated
clusters, apps and native Neo servers. The base fixture prepares an empty
recording cluster, then the identity build selects protected consumer images.
Neither preparation step applies the ordinary Neo graph.

```sh
npm run neo:prepare-fresh -- ../neo-agentfootprint-base-fixture
npm run identity:prepare -- .artifacts/neo/fresh/latest.json
export IAC_TARGET="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; import { join } from "node:path"; const t = JSON.parse(readFileSync(".artifacts/identity/latest.json", "utf8")); console.log(join(t.directory, "target.json"));')"
NEO_IDENTITY_TREE="$(git -C ../neo-agentfootprint-identity rev-parse 'HEAD^{tree}')"
node integration/identity/build-neo.ts ../neo-agentfootprint-identity "$NEO_IDENTITY_TREE" "$IAC_TARGET"
```

The clean identity tree is the protected 7f5e consumer. The build records its
commit/tree and packaging hashes, builds both images, loads them into the exact
cluster, and writes content-derived image identities to the pinned target. Build
before opening Lens so its host captures the final image selection and a full
recording need not wait through image builds. Do not borrow remote image IDs.

Pin that generated absolute IAC_TARGET path for the entire experiment. Copy it
into each new terminal as needed. Do not later reread latest.json to select a
possibly different target. Do not run CLI deployment before the Lens steps:
this test must show genuine first creation.

## 3. Watch one continuous build

From the sibling Lens checkout in terminal A, with the same IAC_TARGET:

```sh
node examples/neo-identity-live.ts "$IAC_TARGET" --port=0
```

Open the printed URL in **Simple** mode. All six objects must be grey before
clicking **Build system** once: Directory, Sign-in, Space, Access, Program and
Network. Keep the same page and chart throughout grey → building → ready. A
fresh target requires six real creates in one native FootPrint deployment run;
there is no separate identity page, bootstrap apply or address-copy step.
The optional `--full` flag is an alias for this same build; the viewer rejects
`--identity-only`.

Fresh Neo configuration uses the sign-in container's stable name on the
prepared local network. The measured connection check verifies its DNS answer
against the owned provider before sending a pinned HTTP request. Existing
targets with a recorded provider IP remain supported. No target or graph is
rewritten during the build.

Node and Python must become Ready without unexpected restarts. Keep this viewer
running through all fault phases; do not reapply or replace it between phases.
The initial schedule preview establishes positions only; native recorded starts
and provider confirmations drive progress. In **Details**, **Deployment flow**
follows native chart/event order and **Running system** follows
communication topology. Select a resource and switch views to verify shared
selection, recorded operation and scoped checks. **Capabilities and placement**
opens the logical inventory. SQLite and session state are embedded in the
runtime; no separate database/PV is provisioned. The cluster is an existing
prerequisite. The fitted main dashboard should need no vertical page scrolling.

After readiness, from the core checkout:

```sh
node integration/identity/forward.ts "$IAC_TARGET"
```

Use the actual **Open Neo** URL. In Simple, click **Check** beside **Sign-in &
access** (or **Check access** in Details) and require 7/7
passed. Connection checks run automatically after deployment; **Check connections**
in Details, or **Check** beside **Connections** in Simple, repeats them. Edges and rows must stream native **Checking → Connected / Failed**
events. These are point-in-time checks; resource colours retain the last recorded
deployment verdict.

Measured paths:

1. Provider → directory: a credential grant through sealed, uncached LDAPS federation.
2. Ready Neo Pod → provider: a real signing-key HTTP request through the declared endpoint, pinned to its verified owned address.
3. Service → Neo: real in-cluster DNS/ClusterIP HTTP health through owned backends.

The seven access checks cover directory availability, reader login, wrong
password rejection, anonymous refusal, reader access, authenticated guest denial
and forged-token refusal. A backend outage is not an expected password rejection
or a measured policy denial.

## 4. Retain completed phases and test failure/recovery

From the core checkout, obtain the full viewer's actual URL once:

```sh
export IAC_EVIDENCE_DIR="$(dirname "$IAC_TARGET")"
export IAC_LENS_URL="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; import { dirname, join } from "node:path"; const s = JSON.parse(readFileSync(join(dirname(process.argv[1]), "lens-live-app/server.json"), "utf8")); console.log(s.url);' "$IAC_TARGET")"
umask 077
curl --fail --silent --show-error "$IAC_LENS_URL/api/state" > "$IAC_EVIDENCE_DIR/lens-baseline.json"
```

Save only after **Check connections**, then **Check access** both finish with
`busy: false` and the expected outcomes. Preserve distinct native run IDs and
each result's evidence/trace paths. Do not save stale earlier outcomes while a
new run is active. Repeat the curl command with each phase filename below.

Run the exact core commands one fault/restoration pair at a time:

```sh
npm run identity:fault -- directory-down "$IAC_TARGET"
# Recheck both panels; save lens-outage.json.
npm run identity:fault -- restore "$IAC_TARGET"
# Recheck; save lens-recovery.json for the directory identity proof below.
npm run identity:fault -- provider-down "$IAC_TARGET"
# Recheck; save lens-provider-outage.json.
npm run identity:fault -- provider-restore "$IAC_TARGET"
# Recheck; save lens-provider-recovery.json.
npm run identity:fault -- service-route-down "$IAC_TARGET"
# Recheck; save lens-service-outage.json.
npm run identity:fault -- service-route-restore "$IAC_TARGET"
# Recheck; save lens-service-recovery.json.
```

Always restore the selected fault, including after a failed assertion. Require
only the selected existing owned resource to change, with its identity retained.
Do not hand-edit routes, delete namespaces or relax admission to obtain a colour.
Keep the original successful deployment recording unchanged throughout.

| Phase | Provider → LDAP | Neo → provider | Service → Neo | Access checks |
| --- | --- | --- | --- | --- |
| Baseline / each completed recovery | Connected | Connected | Connected | 7/7 passed |
| Directory stopped | Failed | Connected | Connected | Directory/fresh-login checks unavailable; anonymous/forged-token refusals can pass |
| Provider stopped | Failed | Failed | Connected | Directory can pass; provider-dependent checks unavailable |
| Service route fault | Connected | Connected | Failed | 7/7 can pass through the separate deployment port-forward |

The Service fault patches only the existing owned target port to unused test
port 5999; restoration returns the original named port. App access can work
while that route fails because its deployment port-forward bypasses the Service.

## 5. Browser checks and recorded evidence

Read this target's generated Alice/Bob passwords privately from credentials.json.
Never copy the file or passwords into a prompt, recording, commit or report.
Sign in as **alice**, choose **zone audit (artifact)** or ask **run a zone
redundancy audit for the RNV site**, and require a completed response and result
table. Sign out, restart provider login if it retains Alice's username, then
sign in as **bob**. Require **Access denied** while Bob is identified as signed
in. A refused login is a different outcome.

The real Neo app deliberately uses a scripted zero-key model and seeded local
data here. It does not demonstrate live LLM reasoning or production collectors.

With directory baseline/outage/recovery snapshots saved above, run:

```sh
node integration/identity/proof.ts "$IAC_TARGET"
node integration/identity/proof.ts "$IAC_TARGET" --offline
```

The first captures actual app permission evidence from the owned Pod; offline
mode checks cached native replay/backwalking and credential scanning. This
built-in proof specifically checks three directory identity phases and app
permission decisions. It does not certify every connection review or the
additional provider/Service fault matrix automatically.
Its credential scan does not traverse connection-review folders; scan those
JSON/JSONL files separately against the generated credential canaries and
JWT/private-key patterns without printing the sensitive values.

For every connection review, take its actual connections.report evidence/trace
paths and connectionId values from its saved snapshot. IDs use compiled relation
indexes, not an assumed 0/1/2. Use the actual files and key with public tools:

```sh
npm run iac -- replay /path/from/connections.report.evidencePath
npm run iac -- explain /path/from/connections.report.evidencePath --key progress:communication:ACTUAL_INDEX
```

Require complete gap-free native logs, replay matching recorded state, and each
decision's reads/control dependencies reaching its own current result/probe,
including consecutive equal outcomes. **Inspect connection recording** and
**Inspect identity recording** open their corresponding native charts. Recorded
provenance describes captured inputs/observations; it cannot prove an unobserved
physical root cause. Retain failed runs as well as recoveries.

If recording, use an isolated background window and match native capture to its
actual physical viewport. Verify a short clip for right/bottom clipping before
deployment. Capture actual first creation and tests continuously with a visible
cursor. Deliver the untouched original plus a playback-compatible copy with
unchanged timing; no simulator, fake progress, cuts, overlays or subtitles for a
raw recording.

Report repository hashes, local test counts, generated target/context/URLs,
actual create/no-op operations, all seven phase outcomes, original/final Pod
identities/restarts, replay/backwalk findings and unverified claims. End healthy
with three connected paths and seven passing access checks. Preserve evidence
and other running work. Cleanup is optional and must use identity:cleanup for
this exact target; do not delete unrelated clusters, change production deployment
or replace Neo's native development workflow.

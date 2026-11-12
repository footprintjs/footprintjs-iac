# Reproduce Create/Find → Details → Connect → Verify on another laptop

This guide exercises the new generic resource workflow with the real local Neo
application. It is separate from the older single-build viewer and versioned
master upgrade examples. The base library owns orchestration and recording;
Neo supplies the identity, consumer configuration and verification adapters.

Generate this laptop's own cluster, target, ports, image identities and private
credentials. Another laptop's fixture directory, localhost URL or Docker cache
is not an input. Run checks directly locally; do not enable CI, dispatch Actions,
push code or modify an existing developer checkout for this reproduction.

## 1. Source and prerequisites

Repositories, all requiring your own GitHub read access:

- Core: https://github.com/footprintjs/footprint-iac
- Lens: https://github.com/footprintjs/footprint-iac-lens
- Consumer: https://github.com/sanjay1909/neo-agentfootprint

Use the exact core and Lens commit hashes supplied in the accompanying handoff
message. Detach the new checkouts at those hashes before installation and record
their actual `git rev-parse HEAD` values. This document does not pin its own
future commit. Do not reset, clean or force-update an existing working tree.

Requirements: a POSIX shell on macOS, Linux or WSL; Node.js 24+, npm, Git, a
running Linux Docker engine, kind, kubectl, OpenSSL and tar on PATH. Initial
builds need access to GitHub and the npm, container and Python registries. Check
Docker VM capacity before adding a cluster. Preserve unrelated applications,
clusters and data; request a specific scoped capacity change if necessary.

Choose a new empty parent directory and keep core and Lens as siblings because
Lens uses `file:../footprint-iac`:

```sh
mkdir neo-resource-flow-review
cd neo-resource-flow-review
git clone https://github.com/footprintjs/footprint-iac.git
git clone https://github.com/footprintjs/footprint-iac-lens.git
git clone --branch demo/neo-master-upgrade-v2-20261111 https://github.com/sanjay1909/neo-agentfootprint.git neo-agentfootprint-v2
git -C neo-agentfootprint-v2 switch --detach 839f6fd726607eb742e76374b94ab8733ef99be2
git -C neo-agentfootprint-v2 worktree add --detach ../neo-agentfootprint-base-fixture 6f876df846ae683cc9e9a114a51b638e31615af2
```

The default consumer is published v2 commit
`839f6fd726607eb742e76374b94ab8733ef99be2`, whose exact source tree is
`5c87acc7852fb4abe71239ad40cd0c584b392672`. It shows the visible v2 demonstration
label. The separate `6f876df846ae683cc9e9a114a51b638e31615af2` worktree supplies
the known base preparation route; it is not the protected consumer image used
in the final deployment. The earlier protected identity baseline remains
`7f5e4546bfcc0f4586e641ab19375c43238165a8` if you need to compare source history.

## 2. Local checks

After selecting the supplied core/Lens commits, run:

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

Record the actual results. Core/Lens validation and a successful Docker image
build do not substitute for Neo's own acceptance gate. For that separate gate,
read the consumer's `AGENTS.md`, `CLAUDE.md` and `docs/LOCAL_DEV.md`, install its
native dependencies, activate its Python environment and prepare its test stores
using its documented local setup. Run `npm ci` and `npm run check` in the v2
checkout after that setup. Report counted skips and unavailable dependencies;
do not weaken gates or create a new Neo development/startup script. Docker is
required by this optional Kubernetes test, not by Neo production deployment or
its ordinary acceptance gate.

## 3. Prepare an absent target and build the v2 consumer

From the core checkout, prepare an empty recording cluster, then a new identity
target. Neither command deploys Neo:

```sh
npm run neo:prepare-fresh -- ../neo-agentfootprint-base-fixture
npm run identity:prepare -- .artifacts/neo/fresh/latest.json
export IAC_TARGET="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; import { join } from "node:path"; const t = JSON.parse(readFileSync(".artifacts/identity/latest.json", "utf8")); console.log(join(t.directory, "target.json"));')"
NEO_V2_TREE="$(git -C ../neo-agentfootprint-v2 rev-parse 'HEAD^{tree}')"
node integration/identity/build-neo.ts ../neo-agentfootprint-v2 "$NEO_V2_TREE" "$IAC_TARGET"
```

Verify the tree is `5c87acc7852fb4abe71239ad40cd0c584b392672` and the build
receipt names the intended published consumer commit. Images are built and
loaded on the receiving laptop; their content identities can differ from the
recording laptop. Pin the printed canonical absolute `IAC_TARGET` for every
terminal. Do not switch to a different `latest.json` later, run a CLI deployment
first, or open the older `neo-identity-live.ts` viewer for this target.

## 4. Automatic Create → Connect → Verify

From the sibling Lens checkout, using that same `IAC_TARGET`:

```sh
node examples/neo-resource-flow.ts "$IAC_TARGET" --mode=create --details=automatic --flow=create-auto --port=0
```

Open the printed URL in Simple mode. Opening the viewer does not deploy resources.
The complete six-object resource chart starts grey, with four compact workflow
stages above it. Start once and observe:

1. **Create resource:** two real source creates, the directory and sign-in
   service. Their actual physical identities are recorded.
2. **Connection details:** real OIDC discovery validates the acquired service
   and produces a profile with public endpoint, protocol and credential/trust
   references. Credentials remain private.
3. **Connect application:** consumes those details and creates exactly four
   owned Kubernetes consumer resources: namespace, policy, Neo Deployment and
   Service. No identity source is part of this mutation plan.
4. **Verify connection and access:** three real communication checks and seven
   directory/login/application access checks, each with native evidence.

Keep the same canvas throughout creation, connection and measured checks.
Details retains deployment/system views, capabilities, inspectors, artifacts
and separate parent/child native recordings. Source and consumer child runs
remain distinct; the viewer never invents one six-resource native apply run.
Existing master history is read-only in this workflow host. Its fixed phase
graphs supply planned positions without creating progress or readiness.

Require two Ready Neo containers with no unexpected restarts. Use **Open app**,
confirm its v2 label, sign in as the generated Alice reader and run **run a zone
redundancy audit for the RNV site**. Separately sign in as Bob and require
**Access denied**. Passwords are in the target's private `credentials.json`;
keep password fields masked and do not put private files into recordings.

The application uses a scripted test model over seeded data for this acceptance
fixture. Its directory, session and embedded application storage are temporary.
This is not a production persistence or general-model-reasoning test.

## 5. Find existing → Connect → Verify

Wait for the first workflow to finish, then stop only that owned Lens process
with Ctrl+C in its terminal. Keep the identity services, Neo, cluster and owned
app forward running. Start a separate workflow against the exact same target:

```sh
node examples/neo-resource-flow.ts "$IAC_TARGET" --mode=existing --details=automatic --flow=find-auto --port=0
```

**Find existing resource** performs read-only lookup and validation. It must not
invoke the source creation engine or take over lifecycle ownership. The same
Connect stage uses the resolved profile. Because Neo is already configured,
its child plan should contain exactly four consumer no-ops and no source apply.
Require the same directory/provider container IDs, namespace/Deployment/Service
UIDs, Service address and Pod identity. Repeat three connected paths and seven
passing access checks with new verification run IDs. A missing existing source
fails; it never silently falls back to Create.

This real test references the prepared local fixture. Generic company/cloud
services use the same base contract through other supported trusted adapters;
this test does not claim to discover arbitrary enterprise LDAP services.

## 6. Human profile handoff and process restart

After the previous workflow is idle, stop only its viewer and start:

```sh
node examples/neo-resource-flow.ts "$IAC_TARGET" --mode=existing --details=human --flow=find-human --port=0
```

Start once. Require Find to pass, Connection details to wait for input, and
Connect/Verify to remain unstarted. Save the completed native pause segment and
the private `resource-flow.json` ledger before continuing. Do not publish that
ledger or share its one-use token.

While paused, stop the viewer with Ctrl+C. Restart the **same command above**,
with the same target, mode, details option and `--flow=find-human`. Open its new
printed URL; `--port=0` may allocate a different viewer port, while Neo's app URL
stays unchanged. The existing checkpoint, execution ID, pending token, completed
Find and unstarted Connect/Verify must remain unchanged. Do not create a new
flow ID or delete/copy state to simulate a resume.

Choose the configured sign-in profile and continue. The browser submits only
the exact one-use pause token and an allowlisted profile ID. It cannot choose
an endpoint, credentials, executable code or another target. Resume re-observes
the same source and validates intended consumer configuration before effects.
Require no second acquisition, four consumer no-ops, three working connections
and seven passing access checks. Wrong/stale tokens and unknown profiles must
be refused without consuming the valid pause; extra endpoint fields are invalid.

There are two native run IDs, one paused and one resumed, joined by an explicit
checkpoint link and matching base state. Keep both recordings. Do not describe
them as one uninterrupted native run. Reopening a completed workflow displays
its result; it does not rerun or reset it.

## 7. Provider failure and recovery, with guaranteed restoration

After all workflows complete, test a scoped provider outage without reapplying
the source or consumer graphs. From the core checkout, this acceptance script
uses existing public fault operations and the integration's read-only verifier:

```sh
node --input-type=module - "$IAC_TARGET" <<'NODE'
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadIdentityTarget, applyNeoIdentityFault } from './integration/identity/index.ts';
import { verifyNeoResourceFlow } from './integration/identity/resource-flow-verify.ts';

const target = await loadIdentityTarget(process.argv[2]);
try {
  const fault = await applyNeoIdentityFault(target, 'provider-down');
  assert.equal(fault.result.ok, true);
  const outage = await verifyNeoResourceFlow(target, join(target.directory, 'acceptance', 'provider-outage'));
  assert.equal(outage.ok, false);
  assert.ok(outage.checks.some(check => !check.passed));
  console.log(JSON.stringify({ phase: 'outage', ok: outage.ok, checks: outage.checks, receipts: outage.receipts }));
} finally {
  const restored = await applyNeoIdentityFault(target, 'provider-restore');
  assert.equal(restored.result.ok, true);
}
const recovery = await verifyNeoResourceFlow(target, join(target.directory, 'acceptance', 'provider-recovery'));
assert.equal(recovery.ok, true);
assert.equal(recovery.checks.length, 10);
assert.ok(recovery.checks.every(check => check.passed));
console.log(JSON.stringify({ phase: 'recovery', ok: recovery.ok, checks: recovery.checks, receipts: recovery.receipts }));
NODE
```

Inspect the separate communication and access results: provider-related paths
and fresh logins should fail during the outage; the direct Neo Service health
path can still pass. An outage is not a successful wrong-password rejection or
policy denial. Recovery must restore the same provider identity and return all
ten checks to passed. Preserve failed and recovered run IDs and evidence; do not
overwrite the failure with a later success. If restoration cannot complete,
retain its recorded outcome and resolve that specific resource before finishing.

These read-only checks produce new evidence under `acceptance/`; they do not
rewrite the completed four-stage workflow or claim continuous monitoring.
To watch the same failure/recovery in Lens, keep its completed workflow open,
apply the scoped provider fault from another terminal, then use **Check** beside
Connections and Sign-in & access. Restore in a `finally` block and repeat both
checks. The two identity-related paths fail during a provider outage while the
Service path may remain connected. Rechecks retain their own native recordings;
the strip says **Workflow complete** for the historical parent, and the canvas
and check summaries show the latest measured health.

## 8. Evidence and return checklist

Each flow retains its state, native segment evidence and JSONL traces under
`<target>/resource-flows/<flow-id>/`. Its `infra/` directory records exact child
acquire/connect graphs and plans; `connections/` and `identity/` retain measured
checks. The shared resource inventory and source ownership guards remain active.
Lens Details exposes admitted public state and native recordings. Private
credentials and raw checkpoint files stay outside viewer artifacts and Git.

Return the actual core/Lens/Neo commits, consumer tree and local check results;
target/context/namespace; separate workflow execution and native leg IDs; exact
child plan actions; before/after source and consumer identities; pause/restart
proof; connection/access outage and recovery results; and evidence/trace paths.
Read-only replay should match captured state without gaps where the native log
format supports it. Scan public recordings for generated passwords and private
key material without printing those values.

If recording the acceptance flow, begin before Start and preserve the complete
unedited capture through profile input, process restart, verification and actual
Neo login/access. Use approved browser/recording tools and actual native events;
do not manufacture stage progress or make a no-op look like a fresh creation.

The workflow keeps resource identity, connection configuration and verification
separate. It does not implicitly promote a master revision, import an externally
owned source, provide production durable conversation storage or recover an
unknown interrupted effect automatically. A durable `running` intent requires
inspection/reconciliation; do not bypass it by manually editing the ledger.

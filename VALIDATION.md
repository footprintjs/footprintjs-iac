# Validation results

Current local library: **footprint-iac 0.4.0**, using pinned **FootPrint 12.1.0** and **Foottrace 1.15.0**. Capability, binding, retention, graph, concurrency, recovery, recorder-backed synthesis and live progress checks passed. Historical Neo integration and clean-clone results are retained below with their original scope.

These are recorded results from the development laptop, not a claim that a fresh clone has already run them. Generated `.artifacts/` evidence, kubeconfig, state and logs are private local outputs and are intentionally excluded from Git. Reproduce the checks directly on your laptop with the [sharing guide](docs/SHARING.md). Automatic GitHub CI triggers are disabled for now; the saved workflow is manual-only. The real Neo integration runs directly through the local IaC command and requires a separately authorized private Neo checkout and local Docker/kind.

## Platform discovery and bootstrap — 2026-11-14

The final library typecheck, **568 tests (0 failed, 0 skipped)** and build pass.
This includes 67 new platform tests; earlier core counts below describe earlier
working-copy states. No Lens or Neo source changes were part of this step.

The new tests exercise local/SSH access admission, extensible tool observations,
multi-host discovery, physical identity checks, capacity/freshness/version
assessment, custom strategy admission, per-action durable intent, one-use
revalidation, unknown-effect retention, native pause/reopen/resume, separate
immutable profiles, private errors, and read-only replay/backwalk. Valid FQDN
Kubernetes node names are admitted without loosening namespace/path selectors.

Additional local acceptance used a disposable Linux SSH server with generated
test-only keys. Actual SSH discovery measured its cgroup CPU/memory limits,
default read-only behavior refused a write, a wrong machine identity stopped a
fixture effect, the correct identity permitted it, and a changed trust file was
refused. The test container and temporary private keys were removed afterward.

A fresh, read-only Find → Connect → Verify run used the already-owned local
Kubernetes v1.37.0 cluster. It measured actual server version, API health,
declared ready nodes, system pods and CNI controller rollout readiness. It ran
zero installer actions. Reopening its native records made zero provider calls.
This does not establish application data-plane traffic or production readiness.

The controlled example in `examples/platform-bootstrap.ts` exercises the
concrete kubeadm/preparation adapters through prepare → init → CNI → native human
pause → reopened resume → connection verification, followed by Find with no host
inventory or installer actions. Seven native captures and causal backwalk proofs
are retained. Installer execution in this example is explicitly controlled; it
does not create a real Kubernetes cluster or change a host system.

Local evidence is in `outputs/platform-bootstrap/` in the surrounding workspace.
See [platform composition](docs/platform-bootstrap.md) and the
[adapter contracts](docs/platform-bootstrap-adapters.md) for reproduction and
scope. Distribution-specific package/runtime setup requires an approved pinned
site recipe and measured preparation probe. Newly created cluster credentials
and first identity registration require a private publication adapter; the
built-in pinned HTTP inspector targets already registered clusters. Rahul's
server was not contacted. No CI, commit, push or package publication was run.

## Assessed Neo release automation — 2026-11-14

The current working copies pass **486 core tests and 213 Lens tests: 699 total**,
with typechecks and builds passing. Historical counts below describe their
earlier validation stages. No GitHub Actions, CI, push, publication or merge was
performed for this follow-up.

Normal Neo release planning now runs recorded provider assessment, binds the
review to its sealed result and revalidates before application effects.
Observation, capability evidence, policy choice, common safeguard admission and
final decision have separate native stages and recorded reads for backwalk.
Unknown or unsupported changes refuse the candidate before apply; this does not
predict every runtime failure or establish arbitrary database compatibility.

A real manual Lens upgrade built one reviewed GitHub source revision and passed
through three distinct local Neo targets in order: dev `5b10aad5`, gamma
`73094b59`, prod `1e234ba6`. Each stage updated `neo-app` once, retained five no-op
resources, and passed three live connection checks plus seven identity/access
assertions. All stages consumed the same prepared package. This acceptance
exercises the reviewed v2 source through a genuine image/Deployment update; it
does not claim a newly published remote application release or new app feature.

At the time of the repository check, Neo had no published GitHub releases; its
release entry was a draft. Live automatic publication-to-deployment acceptance
was therefore not performed. Controlled catalog tests exercise new published
source detection, one build, ordered three-stage initiation, backlog exclusion,
manual initiation, deduplication, durable gates and retained failure/uncertainty.
The running host can discover future published releases and initiate its fixed
pipeline policy; it never publishes a release itself. **Refresh releases** is
discovery-only; **Deploy version** initiates the selected source build and
deployment. Initial `observe` policy leaves the existing backlog alone.

Background-browser acceptance confirmed the three-stage rollout, Alice allowed
and Bob authenticated but denied. The native preflight viewer exposes the
separate observation, capability, policy, safeguard and decision stages. Lens
fits the deployment, running-system graph and checks at 1280×720 without vertical
scrolling. Restarting the host restores Prod, its recorded three connection and
seven access checks, and its matching preflight recording without another build
or deployment. Original measurement times are preserved.

Independent replay verified complete captures with no unread entries or gaps,
36 backwalk queries across the six preflight runs, 18 retained adapter identities
and 12 actual Kubernetes UIDs matching preflight source hashes. The protected
original snapshot is unchanged. Private measured reports, scripts and screenshots
remain under `outputs/neo-release-automation/` in the development workspace.

The targets are local stage fixtures, not configured remote production.
Neo rollback remains disabled in every stage because its local adapter has no
verified restoration contract. Neo's current application storage uses memory
unless MSSQL is configured; this infrastructure preflight neither invents a
database migration nor proves data/schema or live-LLM compatibility. No real
Neo data migration was performed. See the [automation contracts](docs/release-automation.md),
[Neo consumer](integration/identity/release-automation/README.md), and sibling
Lens `docs/neo-release-automation.md` setup guide.

## Change assessment and guarded migration follow-up — 2026-11-14

The follow-up working copies pass **463 core tests and 199 Lens tests: 662 total**.
The earlier suite counts below remain the results of their respective validation stages.

Read-only validation against the real owned Kubernetes Deployment distinguished an
image update from an immutable-selector replacement requirement. The assessment
left its UID, resourceVersion and spec unchanged; no replacement was executed.

The opt-in generic migration workflow and real local SQLite adapter cover API
backup, exact retained user/conversation/message data, a human cutover gate,
reopening in a separate Node process, actual consumer reads/writes, guarded
pre-switch write resumption and refusal of blind rollback after new writes.
Background-browser acceptance then ran the real SQLite example through review,
preview, preparation, a durable human approval gate and a full host restart.
The gate reopened without repeating backup/create/transfer effects. A separate
consumer write was rejected while fenced; approval completed the switch,
application verification, source retention and write resumption. Every original
user/conversation/message field matched, and a new application write reached
schema v2 while the retained original stayed unchanged.

A separate real corrupted-data attempt failed verification before cutover.
Lens kept the original active and exposed **Resume original app**. Explicit
recovery restored writes on the original, preserved its full records and accepted
a new application write. Seven native JSONL captures across both attempts and
the Kubernetes merge-patch assessment replay completely with no unread entries
or gaps. The development workspace retains the measured summary and screenshots
under `outputs/stateful-migration/`; these private outputs are not distributed.

This uses an explicit cooperating single-host fixture; no real Neo database was
migrated. No push, publication, merge, CI or sharing was performed for this
follow-up. See [change assessment](docs/change-assessment.md),
[guarded migration](docs/migration.md), and [SQLite details](docs/sqlite-migration.md).

## Release strategies and real Neo acceptance — 2026-11-14

The release-acceptance working copies at that stage passed **422 core tests and
189 Lens tests**, typechecks and builds. Coverage includes immutable source/artifact manifests, reviewed
source pins, open strategy/adapter registries, capability refusal before
effects, manual promotion, verified application recovery, independent target
locks, native replay integrity, real localhost HTTP/command checks, durable
trigger dispatch and the Neo consumer. Optional Playwright reporter/CLI
contracts were tested without running a real Playwright browser.

A real disposable Neo deployment then consumed a recorded prepared package:
one `neo-app` update, five unchanged resources, all six physical resource
identities retained, three actual connection checks and seven login/access
checks passed. Browser verification independently confirmed Alice allowed and
Bob denied. Five native JSONL captures (build, pipeline, resource deployment,
connections and access) replay completely without unread entries or gaps.
Simple mode fits the timeline and system scene at 1280×720 and opens native
recording/resource details on demand.

This test keeps the previously tested Neo v2 source commit and adds a package
metadata label through a distinct recorded build recipe. It exercises an actual
image/Deployment update; it does not claim a new application feature release.
The live acceptance uses one local environment. Multiple environments,
progressive strategies and application recovery are covered by native contract
tests. Neo's current local adapter exposes direct updates with rollback
disabled. This Neo consumer does not perform resource replacement or migrate
its persistent data; the separate local SQLite migration is described above.
A hosted multi-customer control plane is not implemented. The trigger runtime
needs an operating host to dispatch due ticks; selecting a schedule does not
start a daemon. CI, push, publication and merge were not performed.

Use the [Neo release handoff](docs/NEO-RELEASE-PIPELINE-HANDOFF.md) to reproduce
with this candidate or later reviewed commits. The development workspace keeps
its measured summary and screenshots under `outputs/release-pipeline/`; those
private runtime files are separate from the library distribution.

## Framework

- `npm run check`: passed.
- `node --test --test-concurrency=2 test/*.test.ts`: **262 passed, 0 failed, 0 skipped**.
- `npm run build`: passed; the compiled library imports successfully.
- `npm run demo`: passed creation, response-loss reconciliation, no-op planning, failed update, state replay, backward investigation, and repair.
- `npm run graph:demo`: passed fluent serial/fork/join declaration, actual provider concurrency of two, one create send despite a lost response, unchanged no-op, matching recorded graph digest, failed update investigation, read-only replay and repair.
- Compiled root and focused package exports (`graph`, `graph/render`, `graph/svg`, `diagnostics`, `system`, `system/render`, `binding`) import and run successfully.
- Native parallel JSONL independently reconstructs state and retains each resource stage as the exact writer; dependent backwalk reaches both fork branches without the final execution tree.
- Graph artifacts reject unknown/tampered envelopes, accessor-bearing inputs before invocation, dependency cycles and unsupported required boundary enforcement through every public planner/execution entry point.
- Standalone SVG views parse as XML; a generated security view was rendered and visually inspected. Graph JSON, Mermaid and SVG derive from the same artifact.

Local simulator report: `.artifacts/system-design/latest-report.json`. The new Neo graph consumer has four hermetic tests preserving the exact earlier resource definitions and deployment dependencies.
- Package dry run: generated artifacts and installed dependencies are excluded. Nothing was published.

The suite includes actual `SIGKILL` worker tests, not just injected exceptions. A create persisted by the simulator before the worker dies is discovered on restart without another apply. Native FootPrint records from killed runs remain explicitly incomplete. Other tests cover ownership, target binding, omission handling, drift, reverse-order pruning, locking, CLI behavior, and lost capture.

## Recorded synthesis and live progress

The native chart bridge adds eight regressions, bringing the full core suite to
**262 passing tests**, with typecheck and build passing. The unchanged FootPrint
apply chart and explicit resource-stage bindings are published through the native
`onRunStart` lifecycle after recorder reset and before the first resource event.
Serial gates, real selector/join batches, run/graph identity, repeat no-ops,
rejected topology and observer isolation are covered. Observer publication does
not establish provider readiness or replace the durable operation journal.

The separate Lens deployment-flow follow-up passed **66 tests**, typecheck and
standalone/optional-React builds. Its headless projection validates the actual
native gates/children/joins, uses event sequence for observed starts, and checks
actual overlap without treating category order as execution order. A guard-removal
control fails the intended contradictory-binding regression. Real HTTP tests
observe native topology before the first resource event and confirm that topology
alone cannot make a resource ready. Browser acceptance used the saved real Neo
recording plus a separate local simulator for native live progress, fork/join,
failure, skipped work and a successful existing-resource recheck. No Kubernetes
workload was changed for this visual follow-up.

- Registry versions were checked directly before upgrading to FootPrint 11.1.0 and Foottrace 1.12.0. The full regression suite passes with those exact pins, including independent native JSONL replay and parallel write provenance.
- Six progress tests cover pending/deploying/provider-confirmed-ready states, no-op resets, parallel failure and skipped dependents, confirmed deletion, malformed/mixed-run rejection, subscriber isolation and persisted progress replay.
- Eighteen synthesis tests cover complete desired-state Kubernetes JSON/YAML, dependency-first ordering, deterministic files and hashes, source mappings, backend compatibility, native CloudFormation references, retention and reference cycles, plus checked failure/finalization behavior.
- `npm run synthesis:demo` passed. Kubernetes output uses the actual Neo desired graph. The AWS object-storage profile produces a narrow S3 CloudFormation JSON/YAML example with a synthetic account and no provider calls. Validation is structural; no live AWS deployment is claimed. Binding selection remains static metadata, while resource synthesis and finalization use native recorded stages.
- Six recovered-create regressions verify a fresh post-readiness observation of existence, ownership, fingerprint and physical identity; drift or an unavailable read cannot become a ready event. Three kubeconfig selector tests cover explicit per-command isolation, concurrent adapters and unchanged process environment. CloudFormation retention also checks dependencies introduced by native references.
- Consumer-supplied native recorders can attach through `InfraEngine({ recorders })`. Apply evidence now includes the native build-time structure for Flow Lens.

The separate [footprint-iac-lens](https://github.com/footprintjs/footprint-iac-lens) consumer passed 14 headless TypeScript and real HTTP/SSE tests, typecheck, and standalone/optional-React builds. Headless public imports were also checked with renderer resolution explicitly blocked. Its root and `/core` imports load no React or DOM adapter; `/react` and the execution-evidence surface are separate optional/lazy entries.

Browser acceptance verified initial grey resources, live recorded deploying/ready transitions, injected failure with skipped dependents, resource inspection and native Flow Lens cursor navigation. Against the existing Neo Kubernetes fixture, Lens received nine native progress events for three provider-confirmed ready resources, all with action `noop`. Independent checks preserved Deployment UID and pod template and confirmed the original Neo server remained healthy. The viewer also exposes generated Kubernetes and labelled export-only CloudFormation artifacts. These browser checks used the local simulator and prepared Neo fixture, not live cloud services.

## Identity and access integration

The identity extension initially passed all 245 core tests, typecheck and build. The separate Lens consumer initially passed all 34 tests, typecheck and build. These include exact access-policy semantics, real LDAP adapter admission, sanitized native verification records, replay/backwalking, fixture ownership and sealed inputs, actual container drift, and expected denial versus unavailable identity checks. Current live-viewer follow-up results are recorded below.

A separate local Neo namespace was deployed through the engine with a real OpenLDAP directory and LDAP-backed Keycloak broker. Seven measured checks passed: trusted LDAPS bind/group lookup, correct OIDC credential exchange, wrong-password rejection, anonymous refusal, allowed reader access to Neo's real session API, authenticated guest denial, and forged-token refusal. The directory was stopped and restored through the same engine; Lens recorded unavailable checks during the outage and passing checks after repair while preserving each phase's resource deployment record. Existing signed tokens are not claimed to be immediately revoked by a directory outage.

Earlier browser acceptance verified the OIDC/PKCE sign-in page and an authenticated guest's explicit access-denied screen. On that earlier reviewed app tree, a reader submitted a real Neo request 92.44 seconds after sign-in despite the fixture's original 60-second access-token lifetime, without another login or page reload. The renewed session rendered the three-row, five-column data artifact. The browser integration reads the current bearer and pinned conversation for each artifact request; logout and foreign-user/conversation regressions retain their refusals. Those screenshots and measured browser acceptance remain historical evidence for that deployment.

Actual Neo permission decisions were captured by its isolated native recorder worker. Snapshot and JSONL replay matched; backward slices reached policy, verified subject/groups, action, resource and the governing decision. A scoped scan of saved evidence found no real fixture credential canaries or JWT-like values. Replay/backwalking of cached proof was also verified with provider commands blocked. The Python tool server answered on same-Pod loopback and refused access through its Pod IP. These are separate native evidence layers; no automatic cross-request trace stitching is claimed.

The image-update trial found and fixed plural Kubernetes conflict detection. Two changed container images now receive the existing bounded bootstrap-manager migration with identical UID/resourceVersion preconditions. Foreign managers remain refused; the running app survived the rejected attempt and the guarded retry converged.

The November 10 follow-up fixes the four previously reproduced Neo gate failures: PowerScale guidance now fits the unchanged prompt/headroom limits, cache fallback tests require actual observations, and bounded cache cluster tests assert unique resolution and ambiguity refusal. No production collector query changed. Full validation also exposed a native AgentFootprint file-telemetry race; [the reviewed source correction](https://github.com/footprintjs/agentfootprint/commit/ec7e0f5e3aaf4cba2d813cd7c2ee6e0fd3455b80) serializes timed writes through the existing append queue. Its library suite passed 25,413 tests with 21 existing skips; the exact unpublished build is bundled in Neo and checked against its source, archive hashes and installed runtime bytes.

The [tested Neo integration branch](https://github.com/sanjay1909/neo-agentfootprint/tree/feat/neo-identity-ldap-20261110) is committed at `7f5e4546bfcc0f4586e641ab19375c43238165a8`, based on `6f876df846ae683cc9e9a114a51b638e31615af2`. The former signed-in viewer-state TODO is now a hard assertion: Neo uses the existing native request-bound artifact API before the run, forwarding the original request rather than composing an identity scope. All 23 real HTTP cases pass, including owned row proof, forged cells/labels, foreign references/conversations, authentication and concurrent-reader isolation. Disabling the fix produces six intended failures; exact restoration passes.

Both final complete `npm run check` invocations exited zero: the available-store gate reported 5,259 passed test executions and three skips; the stopped-store gate with Docker disabled for that process reported 4,916 passed executions and 22 explicit skips. Both had zero failures and zero TODOs. Counts sum reported stage summaries, not distinct cases. Typecheck and the final browser build passed. An initial unchanged PowerScale parity subprocess exceeded its existing five-second deadline; the focused test and both final full gates passed without changing that limit or assertion. The initial log and measurements remain private local evidence; its cause was not established. GitHub main's newer changes were preserved; no CI or npm publication was used.

The original checkout and earlier Neo workloads were preserved. The source/gate follow-up itself did not replace the earlier identity fixture's images. A later, separate deployment of the new commit is described next.

### Fresh live capability deployment on November 10

The new owned target `83d8f481`, namespace `footprint-iac-identity-83d8f481`,
uses the previously prepared local recording cluster. Its images were built from
clean committed Neo source `7f5e4546bfcc0f4586e641ab19375c43238165a8`, tree
`a4fc75ef571ee3e9d1f00bf0283120303122dafc`. Build metadata no longer infers test
or publication status from image creation.

Lens started before each apply. The identity bootstrap recorded two actual
creates. Resource run `88b8cf21-22f8-412a-bad0-ef8fa8b32051` then recorded four
Kubernetes creates and two identity no-ops. CUA browser capture showed pending,
Started with a soft fade, and provider-confirmed Ready. Expanded generic
Compute, Storage and Network units followed those native events. Nine logical
units map to six managed resources; this is not nine separately provisioned
services. The cluster is an existing prerequisite, and SQLite/session state is
embedded and shares runtime readiness. No database server or persistent volume
creation is claimed.

The separate Lens suite passed **51 tests**, typecheck and both builds. Controls
also failed as intended when native completion validation, live projection, or
admission ordering was disabled, then passed after exact restoration.

Browser acceptance on the new image verified real OIDC/PKCE reader sign-in,
authenticated access to the scripted seeded zone audit, artifact rendering,
logout, and explicit guest denial. A selected zone row received the server's
Verified acknowledgement, while the disk-only follow-up correctly refused it;
the feature edit omits that unsupported drill-down. The mock provider always
runs the zone audit and does not establish contextual model reasoning.

All seven identity checks passed, failed as expected when the owned LDAP
directory was stopped through the engine, and passed again after restoration.
All three phases retained the original resource recording; the failed native
condition, recorded reads/writes and outcome were inspected in Lens. Generic
communication-edge probes were not run by this identity fixture and remain
explicitly Not checked. This is separate from the seven measured identity
checks.

Post-capture verification observed restarts under Docker VM-wide memory
pressure. Kernel evidence identifies `CONSTRAINT_NONE, global_oom`, not a
container-limit OOM: main Node RSS was about 269 MiB and its recording worker
about 40 MiB. Five kind nodes share a roughly 7.75 GiB Docker VM. Kubernetes
recovered the Pod and the owned forward was restarted; a subsequent `/health`
returned 200. Increasing Neo's 1 GiB limit would not resolve VM-wide pressure.
Older clusters were not silently stopped. The captured readiness is a
point-in-time observation, not a sustained capacity claim; the private target
retains diagnostics and the feature project documents this limitation.

Cached acceptance proof passed against the new live viewer: 20 actual application
permission recordings (16 allowed, four denied), matching snapshot/JSONL replay,
authorization and identity-observation backwalks, unchanged resource recording
across the three identity phases, and Python loopback isolation. A scoped scan
of 83 evidence files found zero fixture credential canaries and zero complete
JWT-like values. The proof admits only the exact owned legacy or live Lens
directories, requires one matching directory across all phases, and scans both
for credentials. Five new regressions bring the full core suite to **254 tests**;
typecheck and build pass. Disabling the same-directory guard fails the intended
mixed-directory regression, then exact restoration passes.

Reproduce this explicitly local integration with [its setup and failure/recovery guide](integration/identity/README.md). It uses the scripted model and seeded SQLite data; it does not establish production SSO, persistent identity storage, fine-grained tool/admin permissions or Kubernetes RBAC.

## Portable handoff validation

On November 8, 2026, a clean local Git clone with no installed dependencies or generated artifacts passed `npm ci`, typecheck, all **159 tests**, build and the capability demo. The six added setup/listener regression tests cover isolated targets, foreign cluster refusal, local kubeconfig admission, complete image identities, source/image matching and recovery from a partially bound port-forward.

From that clone, `npm run neo:setup -- /path/to/clean/neo-agentfootprint` rebuilt both images from the pinned Neo source commit, created the separate `footprint-iac-review` kind cluster, loaded content-derived image tags and passed the real capability deployment, readiness, no-op, scale 1→2→1 and HTTP/SQLite checks. A second `neo:review` passed using the saved durable inventory. Occupied port15230 correctly fell back to a free port; the original test server, Deployment UID and pod configuration remained unchanged.

Separate read-only CLI replay reconstructed the saved final shared state exactly, and CLI inspection parsed the real run evidence. These are additional acceptance checks rather than automatic assertions inside `neo:setup`. The package dry run included the portable setup and guides and excluded local state, credentials, recordings and installed dependencies. This validates a fresh clone on the development laptop; another operating system or laptop still needs to run its own checks.

## Capability base and wrappers

- `npm run capability:demo`: passed high-level compute/storage/network declaration, a separate agentic recipe, explicit simulation binding, expanded graph generation, actual provider concurrency of two, uncertain-create single send, unchanged no-op, failure-to-capability mapping, read-only replay/backwalk, repair and removal retention.
- `src/system` has 18 runtime tests plus compile-time negative API checks.
- Binding has 14 tests, including exact requirement coverage, ambiguous selections, target identity, multi-resource expansion, accessors, async callbacks, simulation/provider mismatches and required constraints.
- Eight retention tests cover persisted protection, saved dependency closure, explicit release, restart, CLI cleanup, policy-only no-op and failed-release safety.
- Regrouping stable capability IDs produces no provider writes. Clearing removal retention alone also produces no provider writes.
- Both high-level intent and expanded resource diagrams are generated. Structured inspection carries the originating capability path, source design digest and adapter mode.
- The built-in capability profile is simulation-only. It does not provision a live cluster, database backend, IAM policy or workload, and does not verify production durability. The separate Neo profile supplies the narrow real implementation tested below.

Local capability demo report: `.artifacts/capabilities/latest-report.json`. See [CAPABILITIES.md](docs/CAPABILITIES.md) for public API semantics and wrapper boundaries.

## Current high-level Neo review

- `npm run neo:review -- --context kind-footprint-iac-test`: passed against the real local Kubernetes API.
- The capability model and explicit real consumer profile expanded into the exact packaged Namespace, two-container Deployment and HTTP Service, deployed only through `InfraEngine`.
- Live readiness, unchanged no-op planning and scaling1→2→1 passed. Deployment UID, app metadata, selector and pod template stayed unchanged.
- Node/Python health, actual app HTML/built assets and the real filtered SQLite inventory query with `LOCAL SEED` provenance passed.
- Nine additional chat/artifact HTTP checks passed: scripted answer/table, same-session redemption200 and cross-session denial404, with full fixture identifiers preserved. These acceptance checks were run separately from the review runner.
- Separate saved real-run replay acceptance matches the snapshot; the recorded deployment result supports backward traversal without provider effects.
- The review runner leaves a loopback server running. Its exact URL, owned PID, command/start time and log paths are in the local `.artifacts/neo/review/latest.json`.
- Image/source attestation matched clean source commit6f876df846ae683cc9e9a114a51b638e31615af2. Tracked upstream app files remain unchanged.
- Local browser automation was unavailable because Work settings disable it; HTTP assets and chat/artifact acceptance were verified. No visual browser result is claimed.

This review uses the scripted model and local fixture data. It does not prove live collector/model behavior, production authentication, persistent storage or multi-replica conversation continuity.

## Real Kubernetes trial

Cluster: `kind-footprint-iac-test`, Kubernetes `v1.37.0`, running locally in Docker.

Namespace: `footprint-iac-neo-test`.

App source: clean committed snapshot of the separate private `sanjay1909/neo-agentfootprint` repository at `6f876df846ae683cc9e9a114a51b638e31615af2`.

The original checkout's tracked files were not modified. Its pre-existing untracked `be-server/.artifacts/` directory was left alone.

The final trial verified:

1. Resource planning, apply and readiness.
2. An unchanged plan/reapply consisting entirely of no-op operations.
3. A real scale from one replica to two, followed by a scale back to one; the Deployment UID, app metadata, images and pod template remained unchanged.
4. Backend health, served UI HTML, Python health and the real SQLite `mds_get_switch_inventory` query, including exact switch filtering and `LOCAL SEED` provenance.
5. Rejection of a negative replica count by the Kubernetes API.
6. Saved Foottrace replay equal to the captured state, plus a backward slice reaching the rejected desired input and governing decisions.
7. The existing app remaining healthy after rejection, followed by restoration and final all-no-op convergence.

Local machine-readable report: `.artifacts/neo/trial-report.json`.

Local readable failure slice: `.artifacts/neo/failure-backwalk.txt`.

Local test log: `.artifacts/test-results.txt`.

## Integration fixes made during testing

The Python sidecar requires the canonical metadata shipped by the installed AgentFootprint Node package. Its Dockerfile now obtains the exact file from the Node image; the build checker verifies identical bytes across both images. The verified file SHA-256 is `04e14b45556ad60fd8ff971ed9710f5cb5a4de59ecd4607a32f60a7834037382`.

The first live update exposed Kubernetes's distinct POST/Apply manager identities. The adapter now supports a guarded bootstrap migration, retaining UID/resourceVersion preconditions and refusing competing ownership. Unsupported desired-field removals fail during planning rather than falsely reporting convergence.

Docker's direct registry path timed out. Required base images were downloaded through the host and loaded into the local daemon; no global Docker settings were changed.

## Scope and retained environment

The test uses seeded SQLite data and the app's scripted model. It did not exercise a live SAN collector or LLM provider. Node dependencies came from the existing Neo lockfile; the install reported 21 upstream audit findings, and dependency upgrades were outside this integration change.

This remains a single-machine prototype with four Kubernetes resource kinds. Execution defaults to one resource at a time; configured bounded batches can execute eligible resource operations concurrently, and pruning remains sequential. Cross-run/tool causal stitching, provider-output interpolation, fine-grained provider subflows, distributed state, arbitrary providers and automatic rollback are not implemented. Boundary groups are descriptive; required enforcement is rejected until a supported lowering/verifier exists. Kubernetes field/list removal and automatic replacement are explicitly unsupported.

The original test cluster was stopped after an earlier session and later recreated for the high-level review above. A localhost URL and an old saved report do not establish present health on another laptop. Use the [portable setup and test instructions](docs/SHARING.md) to create a separate `footprint-iac-review` cluster, generate fresh evidence and obtain that laptop's actual review URL.

## Recorder dependency update — 2026-11-12

The IaC host now pins `footprintjs@12.1.0` and `foottrace@1.15.0`, upgraded from `11.1.0` and `1.12.0`. Version 12.0.0 was also validated before 12.1.0 appeared during this work; its evidence is retained separately. Neo remains a separate consumer application. Its source and application dependencies were not changed by this host update.

Three dependency contracts pass through the public IaC evidence readers: a delayed reader identifies the producer of the value it actually read; a merged configuration retains its original writer; and an ambiguous read window preserves possible sources and an uncertainty note. The matching controlled examples against both published FootTrace versions reproduce the earlier incorrect or missing attribution. These examples establish those specific fixes, rather than a general guarantee of external root-cause identification. See the [1.13](https://github.com/footprintjs/foottrace/releases/tag/v1.13.0) and [1.14](https://github.com/footprintjs/foottrace/releases/tag/v1.14.0) release notes.

An additional isolated FootPrint comparison copies a harmless synthetic hidden inner object into a public wrapper under the same redaction policy. Version 11.1.0 exposes the canary in the served record; 12.1.0 masks it while keeping neighboring public data readable. Both runs produce the same business output. This validates the engine's redaction fix; connection-profile credentials already remain outside chart scope, so it is not evidence of an existing integration leak.

The unchanged Find → human pause → reopened workflow → resume → Connect → Verify benchmark passes under both dependency pairs. Each version retains five commits, 23 provenance-bearing writes and 7,477 JSONL bytes, with no capture gaps. Four earlier real Neo records also replay and backwalk under the new reader without changing the original files. Seven warmed timing samples per version are descriptive only: the upgraded samples overlapped other project checks, so neither their workflow-time increase nor their query-time decrease establishes a performance change. No real deployment speed claim is made.

The released FootPrint 12.1 artifact still emits linked execution trees in the measured workflow. FootTrace 1.15 can also read chain-form trees; its release wording about the producer's format does not match the observed published engine. Original recordings retain their native shape. Optional read-source capture and rich cause adapters already existed in the baseline and were not enabled as part of this dependency update. Version 12 provides optional closure/extent capture and recorder reliability fixes; these are separate from the measured serial-workflow results. See the [FootPrint 12 release](https://github.com/footprintjs/footPrint/releases/tag/v12.0.0). Version 12.1 additionally fixes control attribution after a loop and adds default-branch label metadata. The current Neo charts do not contain a loop, so this is a recorder capability improvement rather than an observed change in Neo's behavior. See the [12.1 release](https://github.com/footprintjs/footPrint/releases/tag/v12.1.0).

The local workspace retains reproducible scripts, raw samples, package archives, hashes and compatibility reports in `outputs/dependency-upgrade/`. These generated artifacts are separate from the library distribution.

The final dependency pair passes 345 IaC tests and 153 Lens tests, typechecks and builds. Real Neo verification through the Lens server API confirms three connections, seven login/access checks, human pause and host restart. A retained real pause created under 11.1.0/1.12.0 also resumes successfully under 12.1.0/1.15.0 with the same execution, selected profile and physical resource; the earlier native record and trace remain byte-identical. These live checks reuse existing resources and do not claim a fresh deployment or browser recording.

## Common deployment strategies — 2026-11-14

The common registry and controller interface support registered systemd and
Kubernetes adapters. Systemd reuses InfraEngine, Master and native check
recordings; coupled units use one service-group transaction. Its generic Linux
host adapter measures the machine, unit fragments, configuration files and actual
running process marker before admitting effects. Kubernetes preserves the
existing guarded controller.

The full local library suite passes **588 tests**, with typecheck and build.
Focused cases include no-op, configuration-only updates on the same physical
ledger, changed targets and service invocations, missing required configuration,
unknown effects, changed check catalogs and retained evidence from a different
target. Narrow neutralizations reproduced the corresponding failures and were
restored. Host and strategy registration are trusted code; neither public graph
data nor a strategy ID can supply executable commands.

These controlled checks establish the library contracts. Real Neo systemd and
Kubernetes acceptance is run separately by the consuming application; it does not
establish readiness of an unregistered production server.

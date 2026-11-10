# Validation results

Current local library: **footprint-iac 0.4.0**, using pinned **FootPrint 11.1.0** and **Foottrace 1.12.0**. Capability, binding, retention, graph, concurrency, recovery, recorder-backed synthesis and live progress checks passed. Historical Neo integration and clean-clone results are retained below with their original scope.

These are recorded results from the development laptop, not a claim that a fresh clone has already run them. Generated `.artifacts/` evidence, kubeconfig, state and logs are private local outputs and are intentionally excluded from Git. Reproduce the checks directly on your laptop with the [sharing guide](docs/SHARING.md). Automatic GitHub CI triggers are disabled for now; the saved workflow is manual-only. The real Neo integration runs directly through the local IaC command and requires a separately authorized private Neo checkout and local Docker/kind.

## Framework

- `npm run check`: passed.
- `node --test --test-concurrency=2 test/*.test.ts`: **245 passed, 0 failed, 0 skipped**.
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

- Registry versions were checked directly before upgrading to FootPrint 11.1.0 and Foottrace 1.12.0. The full regression suite passes with those exact pins, including independent native JSONL replay and parallel write provenance.
- Six progress tests cover pending/deploying/provider-confirmed-ready states, no-op resets, parallel failure and skipped dependents, confirmed deletion, malformed/mixed-run rejection, subscriber isolation and persisted progress replay.
- Eighteen synthesis tests cover complete desired-state Kubernetes JSON/YAML, dependency-first ordering, deterministic files and hashes, source mappings, backend compatibility, native CloudFormation references, retention and reference cycles, plus checked failure/finalization behavior.
- `npm run synthesis:demo` passed. Kubernetes output uses the actual Neo desired graph. The AWS object-storage profile produces a narrow S3 CloudFormation JSON/YAML example with a synthetic account and no provider calls. Validation is structural; no live AWS deployment is claimed. Binding selection remains static metadata, while resource synthesis and finalization use native recorded stages.
- Six recovered-create regressions verify a fresh post-readiness observation of existence, ownership, fingerprint and physical identity; drift or an unavailable read cannot become a ready event. Three kubeconfig selector tests cover explicit per-command isolation, concurrent adapters and unchanged process environment. CloudFormation retention also checks dependencies introduced by native references.
- Consumer-supplied native recorders can attach through `InfraEngine({ recorders })`. Apply evidence now includes the native build-time structure for Flow Lens.

The separate [footprint-iac-lens](https://github.com/footprintjs/footprint-iac-lens) consumer passed 14 headless TypeScript and real HTTP/SSE tests, typecheck, and standalone/optional-React builds. Headless public imports were also checked with renderer resolution explicitly blocked. Its root and `/core` imports load no React or DOM adapter; `/react` and the execution-evidence surface are separate optional/lazy entries.

Browser acceptance verified initial grey resources, live recorded deploying/ready transitions, injected failure with skipped dependents, resource inspection and native Flow Lens cursor navigation. Against the existing Neo Kubernetes fixture, Lens received nine native progress events for three provider-confirmed ready resources, all with action `noop`. Independent checks preserved Deployment UID and pod template and confirmed the original Neo server remained healthy. The viewer also exposes generated Kubernetes and labelled export-only CloudFormation artifacts. These browser checks used the local simulator and prepared Neo fixture, not live cloud services.

## Identity and access integration

The current local identity extension passed all 245 core tests, typecheck and build. The separate Lens consumer passed all 34 tests, typecheck and build. These include exact access-policy semantics, real LDAP adapter admission, sanitized native verification records, replay/backwalking, fixture ownership and sealed inputs, actual container drift, and expected denial versus unavailable identity checks.

A separate local Neo namespace was deployed through the engine with a real OpenLDAP directory and LDAP-backed Keycloak broker. Seven measured checks passed: trusted LDAPS bind/group lookup, correct OIDC credential exchange, wrong-password rejection, anonymous refusal, allowed reader access to Neo's real session API, authenticated guest denial, and forged-token refusal. The directory was stopped and restored through the same engine; Lens recorded unavailable checks during the outage and passing checks after repair while preserving each phase's resource deployment record. Existing signed tokens are not claimed to be immediately revoked by a directory outage.

Browser acceptance verified the OIDC/PKCE sign-in page and an authenticated guest's explicit access-denied screen. On the final reviewed app tree, a reader submitted a real Neo request 92.44 seconds after sign-in despite the fixture's original 60-second access-token lifetime, without another login or page reload. The renewed session rendered the three-row, five-column data artifact. The browser integration reads the current bearer and pinned conversation for each artifact request; logout and foreign-user/conversation regressions retain their refusals. Final Neo and Lens screenshots and measured browser acceptance are saved privately with the evidence.

Actual Neo permission decisions were captured by its isolated native recorder worker. Snapshot and JSONL replay matched; backward slices reached policy, verified subject/groups, action, resource and the governing decision. A scoped scan of saved evidence found no real fixture credential canaries or JWT-like values. Replay/backwalking of cached proof was also verified with provider commands blocked. The Python tool server answered on same-Pod loopback and refused access through its Pod IP. These are separate native evidence layers; no automatic cross-request trace stitching is claimed.

The image-update trial found and fixed plural Kubernetes conflict detection. Two changed container images now receive the existing bounded bootstrap-manager migration with identical UID/resourceVersion preconditions. Foreign managers remain refused; the running app survived the rejected attempt and the guarded retry converged.

The November 10 follow-up fixes the four previously reproduced Neo gate failures: PowerScale guidance now fits the unchanged prompt/headroom limits, cache fallback tests require actual observations, and bounded cache cluster tests assert unique resolution and ambiguity refusal. No production collector query changed. Full validation also exposed a native AgentFootprint file-telemetry race; [the reviewed source correction](https://github.com/footprintjs/agentfootprint/commit/ec7e0f5e3aaf4cba2d813cd7c2ee6e0fd3455b80) serializes timed writes through the existing append queue. Its library suite passed 25,413 tests with 21 existing skips; the exact unpublished build is bundled in Neo and checked against its source, archive hashes and installed runtime bytes.

The [tested Neo integration branch](https://github.com/sanjay1909/neo-agentfootprint/tree/feat/neo-identity-ldap-20261110) is committed at `5e23d8271c7430ae4bbb9a2e306caebc6c2993a3`, based on `6f876df846ae683cc9e9a114a51b638e31615af2`. Both complete `npm run check` invocations exited zero: the available-store gate reported 5,249 passed test executions, three skips and one existing TODO; the stopped-store gate with Docker disabled for that process reported 4,906 passed executions, 22 explicit skips and the same TODO. Neither had failures. Counts sum reported stage summaries, not distinct cases. Typecheck and the final browser build passed. GitHub main's newer changes were preserved; no CI or npm publication was used.

The original checkout and original running Neo were preserved. The separate live identity fixture and browser evidence above remain the earlier reviewed deployment snapshot; this source/gate follow-up did not replace its images or claim fresh browser acceptance of the new commit.

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

# Changelog

## 0.5.0-alpha.4

- Bind `sessionStore()` to Redis or PostgreSQL. Services can read sessions with dedicated credentials. A separate issuer creates and revokes sessions, and each backend enforces expiry.
- Record why a deployment resource waits for a dependency, batch capacity or a batch barrier. Backwalk can also identify a preceding failure that prevented a step from running. Scheduling and plan digests remain compatible.

## 0.5.0-alpha.3

- Export `canonical`, `fingerprint` and `project` from `footprintjs-iac/core`.
- Pass saved provider IDs to adapters and checkpoint generated IDs from apply receipts before readiness checks.
- Resolve non-secret provider attributes from verified prerequisites for dependent resources.
- Add optional adapter-owned change assessment and use it for Kubernetes replacement and field-removal rules.

## 0.5.0-alpha.2

- Add typed capability handles and `.uses(store, access)` while preserving existing design and reference formats.
- Trace binding decisions and provider field changes with `why()` and `whyPlanOperation()`. Exercise the same read-only Fleet store intent on Kubernetes and Docker.

- Mount optional provider apply/verification charts as native FootPrint subflows; retain durable intent, guarded retries and incomplete-effect reconciliation.
- Add isolated core, registry and selected systemd/Kubernetes entrypoints; no-op systemd verification records each registered unit without restarting it.
- Add registered system topology and a reusable systemd default, plus native file-backed component/progress admission for Lens. Keep placement, connections, facts and deployment order separate.

- Add optional versioned onboarding with sealed configuration reviews, explicit activation, stable ownership, expiring CLI fences and retained native histories. Exact configuration no-ops preserve the active head and readiness; missing capture requires reconciliation.
- Expose optional native recorder and chart-observer ports on the systemd deployment adapter, enabling honest live application-host views without another deployment engine.
- Preserve existing sealed plans, target identity checks and replay semantics.

## 0.5.0-alpha.1

First npm alpha of FootPrintJS IaC — InfraChart. Earlier `0.4.0` builds were private portable archives.

- Define compute, storage and network intent, then select concrete providers through adapters.
- Plan changes before effects; record resource reconciliation, versioned Master workflows, checks and deployment decisions with FootPrintJS.
- Select systemd or Kubernetes through one deployment interface.
- Compose generic connection profiles, secret storage, Create/Find → Connect → Verify and human pause/resume.
- Expose native progress, diagnostics, backwalk and recorded evidence for the separate InfraChart Lens dashboard.
- Provide source/release, stage, trigger and migration contracts with registered host strategies.

This alpha retains existing resource ownership and recording identifiers. The API is still evolving. Local Neo acceptance does not establish readiness for a production server; unsupported or unknown provider facts remain explicit deployment blockers.

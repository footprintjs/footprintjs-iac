# Changelog

## 0.5.0-alpha.2

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

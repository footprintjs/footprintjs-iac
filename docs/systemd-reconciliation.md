# Explicit failed-outcome reconciliation

`DeploymentStrategyAdapter.reconcile(reviewId)` observes a retained incomplete systemd attempt through a host-registered inspector. The public request selects an existing review; it supplies no outcome, command, path or success flag.

The original complete failed engine recording, Master attempt and sealed review must agree. The inspector receives the exact original apply request and pre-apply unit context. It admits the original native runtime-completion capture and a subsequent recorded settlement, then measures current systemd jobs. The controller independently verifies the registered machine, installed unit identities and current states. A known failure requires acknowledged runtime control, no manager jobs, stable active/inactive/failed states, and at least one affected unit inactive or failed. An active sibling may keep serving after a partial startup failure; that activity is separate from an unfinished deployment job. All-active groups, busy jobs, transitional states, missing recordings and unknown results preserve the pending operation.

FootPrint records the outcome observations and decision in a new run. Only after that complete native capture is admitted does the engine clear the exact pending intent. It retains the saved resource and fingerprint. The controller appends a `reconciliations` row alongside the unchanged original attempt. This never promotes a revision, restarts services, installs files or repairs data. A corrected package needs a new sealed review and normal deployment.

`RegisteredSystemdHost.inspectJobs()` uses a fixed read-only systemd recipe for registered units. Measured empty or zero job IDs mean no job; unavailable or malformed properties remain unknown. Reading a retained snapshot or repeating an already closed reconciliation only verifies files and never calls the host.

This first reconciliation contract admits known failed outcomes only. An attempt without complete original native evidence remains blocked; a ready runtime is not silently promoted by reconciliation. Adapters that explicitly disable safe retry cannot bypass pending intent by calling `InfraEngine.apply` again.

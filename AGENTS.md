# Library structure

Follow the user's requirement for small, cohesive libraries, helpers, stages and subflows. Keep each flowchart's construction in one dedicated creation file. Put stage behavior and reusable helpers in their owning modules; the creation file should make the flow readable without carrying long implementations inside callbacks. Keep composition roots explicit and dependency direction acyclic.

Graph declaration, validation and rendering perform no provider calls. Keep architectural relationships, deployment dependencies and recorded runtime provenance distinct. Preserve graph envelopes and admission checks at every public planning/execution path. Boundaries only establish enforcement when a supported adapter realizes and verifies the declared requirement.

Preserve durable intent-before-effect, ownership checks, reconciliation after uncertain outcomes and read-only evidence replay. Parallel changes require real overlap, failure/join, persistence and evidence tests. Use focused checks during development and the full typecheck/test/build before reporting completion. No publishing, upstream application restructuring or live infrastructure changes are implied by local library development.

# Capability and wrapper layers

The developer-facing base uses compute (execution), storage (state) and network (communication), with protection/placement/ownership as crosscutting concerns. Keep purpose, data model, sharing, durability, expiration, retention and replication as distinct properties. Session/data recipes expose their defaults; adapters select concrete technology.

System-specific wrappers (agentic, banking or other domains) compose the public base API. Do not add domain-type switches to generic builders, compiler or engine. A named wrapper never establishes compliance or security by itself. Preserve the expanded capability model and binding decisions for review. Simulation profiles must remain explicitly simulated.

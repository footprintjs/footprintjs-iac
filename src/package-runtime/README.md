# Package runtime child operations

This optional module supplies a bounded regular-file package and an owned
filesystem release target. It is a child of an already reviewed deployment
operation; it does not grant target authority or create another deployment
planner. Its public contract is documented in
[`docs/package-runtime.md`](../../docs/package-runtime.md).

Keep construction provider-free and `snapshot()` read-only. File staging,
activation and runtime control occur only during `start()`. The filesystem
operator uses fixed Python operations through the registered host runner; JSON
never supplies scripts, commands or archive extraction rules. Source bytes and
host paths stay in private ports and never enter native snapshots.

Record synced stage intent before target effects. A target-owned pending
activation blocks another operation after an unknown activation or runtime
control result. Known runtime mismatch requires a complete native observation;
incomplete observations remain uncertain. Settle only after complete native
capture admission. Never delete pending history to retry or restore data.

Tests in `test/package-runtime.test.ts` enforce content/ownership, immutable
trees, atomic version switching, actual file preservation, no-effect replay,
native tamper rejection, failure versus uncertainty and scoped staging cleanup.
Actual application process identity is the registered runtime probe's duty;
symlinks, requested version markers and healthy endpoints alone are insufficient.

Reconciliation is limited to an original complete native acknowledgment of
runtime activation. It performs fresh read-only target/runtime inspection and
then records a separate native settlement acknowledgment. Never use it to
assume unknown control completion, re-execute activation or rewrite old capture.
An optional separately digested reconciliation observer must have no effectful
activation method; its registration is host-owned, never a browser input.

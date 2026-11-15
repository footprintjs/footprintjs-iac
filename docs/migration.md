# Recorded stateful replacement

`MigrationWorkflow` is a separate opt-in lifecycle for replacing a resource that holds application state. It does not add destructive replacement or data rollback to the existing deployment engine. Provider-aware assessment describes a proposed change; migration adapters inspect and protect the actual source again before effects.

The native execution is:

```
Inspect original → Quiesce writes → Backup → Create replacement
  → Transfer / migrate → Verify data → Manual cutover gate
  → Revalidate source, fence, backup and replacement
  → Switch consumer → Verify consumer → Retain original → Resume writes
```

The original source, backup and replacement are never deleted by this API. Write quiescence remains in force during the manual gate. This first strategy is an offline transfer with explicit interruption to writes; it does not claim zero downtime or catch-up replication.

## Public composition

- `footprint-iac/migration` exports types, structural readers, `offlineTransferStrategy` and pure `compileMigrationPlan`.
- `footprint-iac/migration/node` exports `MigrationWorkflow`, `FileMigrationStore`, `FileMigrationLocks` and read-only `loadMigrationRecording`.
- `footprint-iac/migration/sqlite` supplies the local cooperating SQLite adapter and consumer.
- `footprint-iac/change-assessment/node` supplies sealed assessment reports and provider-aware assessment workflows.

```ts
const plan = compileMigrationPlan(definition, registry);
const workflow = new MigrationWorkflow({
  definition,
  // Optional full report: the host may also declare a replacement explicitly.
  assessment: verifiedAssessmentReport,
  registry,
  store: new FileMigrationStore(privateAttemptDirectory),
  locks: new FileMigrationLocks(sharedPrivateLockDirectory),
});

workflow.subscribe(state => publishSafeProjection(state));
const prepared = await workflow.start();
// Retain this exact action on the host; expose an approval button in Lens.
if (prepared.pendingAction?.kind === 'cutover') {
  const { kind, ...request } = prepared.pendingAction;
  // Call only after the operator approves the verified replacement.
  await workflow.cutover(request);
}
```

A definition binds a stable migration ID, assessment digest and selected change ID, host configuration digest, physical source identity, registered destination, strategy ID and adapter ID. It contains no database rows or credentials. Provider-specific paths and programs belong in host adapter configuration. Lens clients choose registered plan IDs and cannot supply those paths, commands or programs.

When a full assessment is supplied, admission verifies its sealed digest, selected replacement change, known data classification and target scope hash against the migration source scope. The native definition digest also binds whether the report was supplied. Without a report this is an explicit host-declared replacement, not a provider-assessed claim. A read-only assessment is point-in-time evidence, not permission or a guarantee that a later operation will succeed. The host maps the selected resource to the migration's physical source identity; provider observation identity hashes and migration identity hashes are not automatically interchangeable.

## Strategies and effect adapters

Strategies are pure functions returning the protected phase sequence. The first built-in strategy uses operation IDs equal to the phase names. A host-defined strategy can choose another registered operation for transfer or another phase, while retaining the protected order. The core has no SQLite, Neo, Kubernetes, database brand or domain switches.

The adapter declares supported capabilities before execution. The entire sequence is admitted before effects. Each operation receives a request bound to the exact execution, operation ID, migration definition, assessment, source, destination and current checkpoint. A receipt must echo that complete request and include measured observation. Substituted source, destination, backup, fence, checkpoint or receipt identities stop execution.

Every effect writes and syncs its operation intent before the adapter runs. The adapter must atomically revalidate its request under its own provider transaction or write lock, and must enforce the write fence against all supported application writers. A core process lock alone cannot fence database clients or arbitrary external tools. Source observations and retained data fingerprints detect drift; they do not make non-cooperating writers safe.

Public receipt proofs contain hashes and stable IDs:

- Physical source and destination identities and complete data snapshots.
- An execution-owned durable write fence.
- A measured backup ID, content digest and independently verified fenced-source snapshot.
- Data verification binding the fenced source snapshot to the replacement snapshot.
- A consumer check binding the active physical identity to a recorded result.

Opaque backup locations, database paths, raw rows, credentials and provider exception strings remain outside native scope. An adapter's private receipt metadata may retain host handles in the private ledger. Exact invariant checks must validate the application's retained records and schema contract; equal row counts alone are insufficient.

## Manual gates and process restarts

`start()` runs through data verification, retains native evidence and returns a durable cutover action. The action is bound to the execution, complete checkpoint digest and immutable definition. Opening the same attempt in a new process does not rebuild or repeat effects.

`cutover()` first runs a new native revalidation step. It requires the same physical source and source snapshot, exact execution-owned fence, unchanged backup, exact replacement identity and data snapshot, and prior passed data verification. A changed source, missing backup, replacement substitution, changed fence or stale action prevents the switch. The original source remains selected when no cutover operation was issued.

The resumed portion is a finite native chart referencing the prepared run ID. This is an explicit durable continuation; it does not pretend that one in-memory executor checkpoint controls every external tool. Gate actions and completed outcomes become visible only after their native recording is retained. A crash before that point leaves an inspectable running/incomplete attempt and never authorizes blind repetition.

## Failure and recovery

A confirmed failure stops later phases. Before switch, the workflow has not issued consumer routing changes. A failed or unknown adapter can still violate its contract; the measured active identity is retained and never replaced by an assumption that the original stayed active.

A pre-switch manual recovery can verify the unchanged original and resume its writes when the adapter supports `verify-recovery` and `resume-source`. It leaves the backup and partial replacement retained. It does not delete them.

After a confirmed switch failure, manual recovery requires all of:

1. The original is retained and unchanged, and the exact fence is still held.
2. The replacement, backup and checkpoint remain bound and unchanged.
3. The adapter independently proves there have been no new writes after cutover and that the original consumer/data contract is compatible.
4. The adapter explicitly supports `recover-source`, `verify-recovery` and `resume-source`.

Only then may an explicit `recover()` action switch back, verify the original consumer and resume its writes. No automatic rollback occurs. Unknown outcomes, new writes, uncertain write history, incompatible data, unsupported recovery or a failed recovery produce an inspection state. The current SQLite adapter deliberately does not implement post-switch pointer rollback.

An `inspect` pending action is informational: it does not authorize `cutover()` or `recover()`. The host/operator must investigate actual provider state. A failed, waiting or uncertain attempt cannot be restarted with `start()`. Restoring application artifacts is separate from migrating or restoring persistent data.

## Native evidence and ownership

Each chart construction is in its own file: preparation, cutover and recovery. Native decision nodes retain skipped phases, operation receipts and checkpoint outcomes. The recorder captures source/target identity hashes, write-fence ownership, backup and verification proofs, request binding and actual consumer state. It does not invent provenance inside an external migration program.

`loadMigrationRecording` is read-only. It validates run/definition/execution identity and complete native trace replay against the retained snapshot for completed segments. Reopening a completed attempt checks native summaries against the private ledger; edited checkpoint JSON cannot authorize cutover.

All attempts controlling the same physical source must share one `FileMigrationLocks` directory on the host. The provider's durable fence remains active while the process lock is released at a human gate. These local locks are not a distributed ownership service. Multi-host orchestration requires a transactional shared state/lock service and provider-level fencing before claiming that safety property.

The local SQLite integration uses temporary, explicitly owned test files for acceptance. It does not migrate Neo's application data, create a production replacement or introduce a deletion path.

# Verify, install and observe a package

`footprintjs-iac/package-runtime/node` supplies a reusable regular-file
installation adapter. A deployment controller still owns its sealed review,
target registration, resource permit and application promotion. This native
child flow runs **Verify package → Stage files → Activate version → Observe
running code** inside that controller's existing provider operation.

The browser-safe `/package-runtime` entrypoint exports types and stable stage
IDs. Node-only package building, filesystem operations, admission and native
recording live under `/package-runtime/node`. No React dependency is introduced.

```ts
import {
  buildDirectoryPackage, createFileReleaseTarget, PackageActivationWorkflow,
} from 'footprintjs-iac/package-runtime/node';

// Explicit build adapter work, outside declaration or target inspection.
const source = await buildDirectoryPackage({
  id: 'application', directory: verifiedSourceDirectory,
  paths: approvedRuntimeFiles,
});
const target = createFileReleaseTarget({
  id: registeredTargetId, directory: privateReleaseDirectory,
  runner: registeredHostProcessRunner,
  // Explicitly allow a different runtime UID to traverse sealed code files.
  // The default is owner-only. Journals always remain private.
  allowRuntimeTraversal: true,
});

// Construct this child only within the existing reviewed provider call.
const child = new PackageActivationWorkflow({
  id: 'application-package', directory: privateOperationDirectory,
  package: source, target, configurationDigest: reviewedConfigurationDigest,
  runtime: {
    async activate() { await registeredSystemdHost.applyUnits(request, context); },
    async observe() { return measuredRuntimeCodeIdentity(); },
  },
});
const result = await child.start({ operationId: context.operationId });
```

`DirectoryPackageManifest` binds the package ID and sorted complete file list,
relative paths, content hashes, byte lengths and executable modes. The private
source port reads exact bytes by registered relative path. The implementation
rejects traversal, `.git`, `.env` variants, its reserved `.package.json` marker,
duplicate/conflicting paths, symbolic links and hard links. There is no tar
extraction and no executable command in package JSON. The current limits are
4,096 files and 128 MiB of content; unsupported packages fail rather than
silently omitting files. The build helper does not install dependencies or
include unlisted files. The site registers its complete runtime inputs and
compatible dependency runtime explicitly.

`createDirectoryPackageSource({directory, manifest})` reconstructs the private
content port from an admitted immutable manifest without reading a filesystem.
Target resolvers and read-only snapshots can use it. Every subsequent `read`
applies the same canonical-path, regular-file, content-hash and executable-mode
guards as the build helper. It never substitutes an unchecked filesystem reader.

The fixed filesystem recipe runs locally, over SSH or through a management
transport using the existing `HostProcessRunner` interface. The source directory
and release directory need not be on the same machine. Only bounded file bytes
are sent through that private channel; native recordings contain digests and
measured outcomes. File names are package-relative, not host paths.

The release target must initially be absent beneath an existing canonical
parent that is not group/other writable. It enrolls that explicit directory with
an owner identity bound to machine, path, filesystem object and traversal policy.
An unrelated nonempty directory is refused. It stages checked files under an
exclusive temporary directory, seals complete package files/directories
read-only, then renames the completed package to `releases/<digest>`. Failed
staging removes only that operation's exclusive temporary directory. Completed
releases and application data are never removed.

Activation revalidates target identity, prior current version, package content,
file/directory ownership and sealed modes. It syncs a pending intent, atomically
replaces the relative `current` symlink, then delegates runtime activation to the
registered port. Owner-only is the default traversal policy. Opting in uses
0711 for the owned root and release container, 0555 for sealed package
directories, 0444/0555 for package files and 0600 for journals. Changing that
registration policy or writable sealed-tree drift is refused before activation.
An administrator capable of overriding filesystem protection remains trusted;
file modes are not an application sandbox or defense against a malicious root.

The runtime observation is:

```ts
{
  runtimeId: measuredInvocationIdentity,
  packageDigest: actuallyMeasuredPackageDigest, // null if a known other package
  ready: actualApplicationReadiness,
  evidence: {
    method: 'process-files', // or 'immutable-image'
    digest: measuredEvidenceDigest,
    complete: true,
  },
}
```

The probe must establish a real process invocation or immutable image identity
and its actual code files/content. A requested release marker, current symlink,
or healthy HTTP endpoint does not establish loaded application identity. A
process/files probe cannot prove arbitrary V8 memory contents; it can establish
that a pinned fresh invocation started from exactly measured immutable inputs.
External dependencies and application acceptance keep their separate checks.

`ready` means all native stages and a complete runtime observation confirm the
expected package and readiness. `verification-failed` means a complete measured
observation found wrong code or failed readiness; its child proof remains
available, the installation is settled and the parent still must refuse
application promotion. Neither outcome rolls back automatically.

Thrown activation/control/probe errors, incomplete runtime evidence or capture
loss retain `incomplete`. A target-owned pending operation prevents another
activation even from a different workflow directory. Refresh reads retained
native evidence only; it does not invoke the target or probe. A failed
pre-activation package operation retains a complete failed native recording.
Known terminal status/receipts must agree with native capture and JSONL replay.

Recovery is explicit: make a new reviewed operation selecting a retained,
verified prior package. The previous and candidate releases remain available.
This restores application code selection only; it does not restore databases,
sessions, process memory or reverse writes. Unknown operations need trusted
inspection/reconciliation, not deletion of their journals or an invented retry.

## Reconcile an acknowledged activation

`await child.reconcile()` supports one narrow recovery case: the original
complete native capture and JSONL must prove `runtimeActivated === true`, and
the exact original receipt must still own the target's current package and
pending operation. It never stages files, switches packages, restarts services
or calls `runtime.activate` again. Unknown control completion, missing original
capture and unrelated targets cannot be settled by guessing.

The constructor may register a separate, read-only observer:

```ts
reconciliation: {
  configurationDigest: reviewedReconciliationProbeDigest,
  async observe(context) { return inspectOwnedRuntime(context); },
}
```

This registration has no activation method. Its digest is recorded in every
appended reconciliation leg; the original definition/configuration and capture
bytes remain unchanged. This allows a more precise observer to establish that
an owned stopped process is a complete negative observation. Changing a probe
does not relabel the original attempted activation or its evidence.

Reconciliation first records **Inspect owned activation → Observe actual
runtime → Classify measured outcome**. Only complete evidence can proceed to
the second native chart, **Settle acknowledged activation**, whose capture
records the exact target journal acknowledgment. Both legs preserve native
read/write provenance and require complete capture/trace admission. A complete
negative becomes `verification-failed`; matching ready code becomes `ready`.
Incomplete observation or an unknown settlement response remains `incomplete`.

The original recording remains immutable. `reconciliationBase` preserves its
observation, `reconciliations` appends linked native proofs, and the current
`observation` reflects the latest admitted measurement. A closed repeated call
and `snapshot()` only read retained proof; they perform no provider/probe work.
The public Node helpers `packageActivationProof(state)` and
`admitPackageActivationRecording(state, directory)` select the latest proof and
admit the original plus the full appended chain. Private settlement evidence
contains explicit recording-file references so another trusted controller can
replay the chain without guessing filenames or scanning a directory.

An original complete `verification-failed` operation that already settled may
also receive an explicit native acknowledgment certificate. The target must
prove that its **last** operations-journal entry exactly matches the original
receipt, package, physical identity and original failed settlement proof. The
backend re-acknowledges it without rewriting that entry. A later operation,
missing proof, unrelated receipt or an original ready activation cannot be
relabeled as that failed settlement. Once a certificate exists, repeated calls
remain read-only.

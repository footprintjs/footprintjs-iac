# Existing-system connection profiles

Connection profiles belong to the base library. A consumer such as Neo supplies an adapter schema and trusted validation policy. Lens renders that schema and submits public configuration separately from credential values; the base registry validates and saves the result. No adapter type switches belong in the registry or the dashboard.

Import `ConnectionProfileRegistry`, the catalog contracts, and memory adapters from `footprintjs-iac/connection-profiles`. Import `FileConnectionProfileStore`, `EncryptedFileSecretStore` and `loadOrCreateSecretKey` from `footprintjs-iac/connection-profiles/node`.

```ts
const profiles = new ConnectionProfileRegistry({
  profiles: new FileConnectionProfileStore(hostSelectedProfileDirectory),
  secrets: secretStoreAdapter,
  adapters: [{
    schema: {
      id: 'company-service-v1',
      label: 'Company service',
      fields: [
        { name: 'endpoint', label: 'Server address', kind: 'url', required: true },
        { name: 'username', label: 'Account', kind: 'text', required: true },
        { name: 'password', label: 'Password', kind: 'password', secret: true, required: true },
      ],
    },
    async validate({ config, secrets }) {
      // Admit endpoint against host policy BEFORE DNS, discovery, or any network I/O.
      admitCompanyEndpoint(config.endpoint);
      await readOnlyConnectionCheck(config, secrets);
    },
  }],
});

// UI or a trusted configuration loader use the same registration interface.
const profile = await profiles.register({
  adapterId: 'company-service-v1', label: 'Company directory',
  config: { endpoint: 'https://directory.company.example', username: 'reader' },
  secrets: { password: userSuppliedPassword },
});
// Execution receives a saved profile ID, never credentials in the graph or resume payload.
const { profile: pinned, secrets } = await profiles.resolve(profile.id);
```

`ConnectionProfileCatalog` deliberately exposes only `schemas`, `list`, `register` and `test`. A dashboard host must pass this narrow surface and never add `resolve` to an HTTP response. Credential inputs should be cleared after submission and must never enter local storage, workflow snapshots, recorder data, logs, error responses or graph JSON. A secret-store adapter must return safe opaque references, never credential values. For example, a managed-secret adapter may return a version-pinned vault reference; the base does not impose the local adapter's reference syntax.

`register` calls schema checks and the trusted adapter's optional read-only validation before writing credentials. `resolve` repeats validation against the saved immutable profile. `test` returns a safe measured result; if the adapter has no validation hook, it returns `connection-check-unavailable` rather than claiming connectivity. These registration probes are not themselves FootPrint recordings. The Create/Find → Connect → Verify workflow owns recorded infrastructure and application evidence.

The host, not the browser, chooses approved adapters and the filesystem, secret backend and network policy. The schema alone cannot establish that an endpoint is safe. In particular, a general server accepting untrusted endpoints must apply outbound network and redirect/DNS policies inside its adapter before probing. The Neo consumer uses a fixed prepared-service policy for its integration test.

Every profile is immutable, with a generated safe ID, schema version, revision and content digest. `revise(oldId, registration)` writes a new ID and links to the prior revision. Existing workflow references remain pinned. Adapter IDs should be versioned when configuration semantics change. The profile store rejects overwrites and revalidates digests on reads. A digest detects accidental edits; it is not a signature against a malicious host that can rewrite both the profile and digest.

The shared `CONNECTION_PROFILE_CAPACITY` is 128 published revisions per catalog. It is also available from the browser-safe `footprintjs-iac/connection-profiles/limits` entry point. Registration rejects a full catalog before running its adapter probe or allocating credentials; stores enforce the same limit atomically during publication so concurrent requests cannot overflow it. Revisions count toward the limit, and saved IDs are never silently evicted because paused workflows may still need them. A concurrent request that loses the final slot cleans its unpublished credentials and receives the safe `profile-capacity` error. Custom profile stores must enforce this same limit transactionally. Local file stores serialize same-process writers and use the existing host-owned file lock for process exclusion; contention with another live process may return a safe storage-unavailable result for retry rather than guessing ownership or exceeding capacity.

Only public settings and opaque secret references live in profile JSON. Secrets resolve inside host adapters. An existing resource requires its initial locator/profile before Find; a later human pause may request a saved connection profile for missing consumer bindings. Finding a system does not transfer lifecycle ownership or authorize its replacement.

Pass a dynamic catalog into `ResourceFlowWorkflow` when users can register profiles after the host starts:

```ts
const workflow = new ResourceFlowWorkflow({
  definition, store, adapters,
  profileCatalogId: 'company-connections-v1',
  profiles: async () => (await profiles.list()).map(({ id, label }) => ({ id, label })),
  requireProfileAtStart: true,
});
const state = await workflow.start({ profileId: profile.id });
// A human-details adapter can interrupt here. After reopening the same host:
await workflow.resume({ pauseToken: state.pause!.token, profileId: profile.id });
```

`ResourceFlowWorkflow` and `FileResourceFlowStore` are Node exports from `footprintjs-iac/resource-flow/workflow`. The adapter receives `context.profileId` before Find. The native pause and checkpoint pin that selection; adding a different profile or revision does not change the in-flight workflow. Start and resume reject credential fields. `requiresProfileAtStart` lets a viewer expose the requirement without maintaining a second execution policy. Static profile catalogs and their existing definition digests remain compatible.

The file adapters are for a trusted local host. They require private owned directories and private files, reject symlink leaves, publish append-only files with flush-before-publication, and encrypt credential files using AES-256-GCM with per-entry IVs and reference-bound authentication. The encryption key is never enumerable on the secret-store object. `loadOrCreateSecretKey` is a private-file local-development bootstrap; storing a key on the same machine is not a managed key service. Production hosts can supply keys from their own key management and implement `SecretStoreAdapter` for a managed vault or another approved backend.

Registration stores credentials before publishing the profile. If profile publication reports an uncertain outcome, the registry rereads the immutable ID: a matching published digest reconciles the operation; unavailable storage preserves credentials for later reconciliation. Confirmed unpublished allocations are cleaned up best-effort. Hosts may reclaim unreferenced secret entries left by crashes using their secret backend's retention policy.

# Session stores

Use `sessionStore()` for opaque string sessions. A service can declare read access while a separate issuer creates and revokes tokens.

```ts
import { artifact, system, type ServiceHandle, type StoreHandle } from 'footprintjs-iac/system';

const app = system('shop');
let sessions!: StoreHandle, api!: ServiceHandle;
app.addStorage('state', group => {
  sessions = group.sessionStore('sessions', s => s.expiration({ absolute: '30m' }));
});
app.addCompute('work', group => {
  api = group.service('api', s => s.program(artifact('api')).uses(sessions, 'read'));
});
```

Register `redisSessionAdapter` or `postgresSessionAdapter` in your binding profile. Give it a storage rule matching `{ family: 'storage', kind: 'store', properties: { purpose: 'session' }, adapterId: adapter.id }`. Keep the service's compute adapter in the same profile. Call `bindSystem(app.build(), profile)`. The bound store resource identifies authorized services and the configured maximum lifetime. The client supplies a positive lifetime for every issued token, including when using `sessionStore('sessions')` without a maximum.

### Connect an existing database

Import only the selected product from `footprintjs-iac/session-store/redis` or `footprintjs-iac/session-store/postgres`. The runtime accepts authenticated client callbacks. Credentials stay with the host. The database and login setup below is explicit.

| | Redis | PostgreSQL |
|---|---|---|
| Open the bound store | `redisSessionStore(binding, sessions)` | `postgresSessionStore(binding, sessions)` |
| Set up access | Call `store.configureReader(adminCommand, api, password)`. It sets the dedicated user's ACL to GET on this store's key prefix. Apply the host's normal ACL persistence procedure. | Call `store.install(adminQuery)` once to create the private schema, token lookup function and dedicated reader roles in one transaction. Existing names cause the installation to fail. Grant `store.readerRole(api)` to a dedicated, unprivileged service login. |
| Supply the service connection | Authenticate as `store.readerRole(api)` and pass `args => client.sendCommand(args)` to `store.reader()`. Use the primary and database 0 for the issuer and reader. | Authenticate as the service login and pass `(sql, args) => pool.query(sql, args)` to `store.reader()`. Use a primary connection with read-committed isolation. |

Use a separate trusted connection for `store.issuer()`. Its `issue(value, lifetimeMs)` returns a new random token and `revoke(token)` is repeatable. The service calls `reader.read(token)` on each authorization check. Missing, expired and revoked tokens return `null`. Connection or permission errors propagate to the caller. A caller-side cache or a lagging replica can serve stale data.

Redis expires the key and deletes it on revocation. PostgreSQL checks the database clock and revocation flag on every lookup. Its function rejects reads from standby servers and transactions with a fixed snapshot. PostgreSQL row retention and deletion remain operator decisions.

These adapters support absolute expiry and read-only service grants. Binding rejects idle expiry, write access and additional storage guarantees the adapter cannot provide. Binding is pure. Database creation, ongoing grant reconciliation and credential distribution belong to the host deployment in this version.

### Run the same contract on both backends

From the source checkout with Docker running, execute `npm run test:session-stores`. It starts Redis 7.4 and PostgreSQL 17 on temporary loopback ports, authenticates a separate service login for each, verifies read access and database-level write denial, then checks expiry and explicit revocation. The command closes the clients and removes both containers.

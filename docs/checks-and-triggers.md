# Registered checks and finite monitoring

Release policy depends on the generic `CheckRunner` interface. HTTP, a command-based test runner, Playwright or a company-specific probe are adapters. A `CheckRequest` names an exact immutable suite, release, environment, stage and invocation; it has no executable, URL, filesystem path or environment variables. The sealed release digest joins the run to its source commit, build recipe and artifacts. Only `passed` is eligible for promotion. `failed`, `inconclusive`, `error` and `skipped` stop a gate.

Browser-safe admission/types are exported from `footprintjs-iac/checks` and `footprintjs-iac/triggers`. Node effects are separate exports from `footprintjs-iac/checks/node` and `footprintjs-iac/triggers/node`. Lens sends registered IDs. The host owns catalogs, credentials, authorization and private configuration.

```ts
import { HttpCheckAdapter, CommandCheckAdapter } from 'footprintjs-iac/checks/node';

const http = new HttpCheckAdapter({ id: 'http', suites: [{
  id: 'readiness', label: 'Application ready', kind: 'http', digest: reviewedSuiteDigest,
  requests: [{ id: 'ready', url: 'http://127.0.0.1:8080/ready', expectedStatus: 200 }],
}] });
const integration = new CommandCheckAdapter({ id: 'integration', suites: [{
  id: 'access', label: 'Login and permissions', kind: 'command', digest: reviewedAccessDigest,
  command: { program: process.execPath, args: ['/trusted/app/test-access.mjs'], cwd: '/trusted/app' },
}] });
```

The command adapter uses `execFile` without a shell. The host registers the executable, arguments, working directory and optional environment once. A suite returns a bounded JSON report, for example `{"checks":[{"id":"login","status":"passed"}]}`. A nonzero process status cannot turn an all-passed report into a passed gate. Timeouts, invalid/oversized output, crashes and conflicting results become safe error observations. Reports and stderr are never copied into native scope. Test programs can have effects; review suites as trusted code.

`playwrightCheckAdapter` is optional and uses an already installed CLI path and registered suite/project. It invokes `test <registered-suite> --reporter=json --workers=1`. It does not install tools or browsers. Standard reporter outcomes are normalized; empty, flaky, interrupted, skipped or expected-failure-only runs cannot pass. Browser-supplied commands, suite paths, environment variables and endpoints are not supported. Reporter/parser tests do not establish that a real browser ran.

`CheckWorkflow({runner,request,store:new FileCheckStore(directory)})` runs one finite native FootPrint chart: bind release and suite → run registered checks → evaluate result. It saves running intent before invoking the tool. Each run retains the immutable request, normalized observations, native execution structure, narrative, read/write provenance, control dependencies and JSONL trace. Tool internals are not inferred. Safe artifact references may be included; signed URLs, credentials and host paths are excluded. Host-only receipt paths remain in the private local ledger and are omitted from native scope. Failed runs are retained. Reopening a completed invocation verifies its native receipt and never repeats the tool. Interrupted or incomplete runs require inspection; retries use a new immutable invocation.

# Trigger adapters

`TriggerDispatcher` composes registered trigger adapters with the same check runners. The included adapters demonstrate three strategies:

| Adapter | Dispatch input | Meaning |
| --- | --- | --- |
| `ManualTriggerAdapter` | Registered trigger ID and stable request ID | One deliberate check run; repeated request IDs dedupe |
| `StageEventTriggerAdapter` | Registered trigger ID and persisted event reference | Check only after a verified, bound stage outcome |
| `IntervalTriggerAdapter` | Host calls `tick()` | Dispatch due finite monitoring jobs |

An interval definition specifies `schedule:{everyMs,startsAt}`, `missed:'skip'|'coalesce'` and `overlap:'skip'`. A scheduler host supplies the clock and wakeup mechanism; a system scheduler, service worker process or another scheduling adapter can call `tick()`. There is no infinite background loop in the library or Lens and no animation that manufactures monitoring progress. A late tick either records one skip or coalesces one run; it never replays an unbounded backlog. Each actual invocation creates a native `CheckWorkflow` recording.

```ts
import { TriggerDispatcher, FileTriggerStore, IntervalTriggerAdapter } from 'footprintjs-iac/triggers/node';
const dispatcher = new TriggerDispatcher({
  definitions: registeredJobs, adapters: [new IntervalTriggerAdapter()], checks: [http, integration],
  store: new FileTriggerStore('/private/state/monitoring'),
  readCurrent: async job => deployedReleaseRegistry.readActual(job.target),
});
await dispatcher.tick(); // Scheduler host calls this again at its next wakeup.
```

`readCurrent` reads the actual deployed release at dispatch, rather than a version captured when the monitor was configured. Monitoring never deploys, promotes or rolls back by default. A monitor failure is evidence for a separately authorized policy, not permission to change a provider.

For stage events, pass `pipelineStageEventReader(id => boundPipelineWorkflows.get(id)?.snapshot())` to `StageEventTriggerAdapter`. It reloads the bound pipeline and native receipt, requires a successful final `outcome`, and checks definition/execution/stage/sequence identities. The dispatcher also rejects an event whose release differs from the actual deployed release. Receiving a browser event body, a promotion-gate event or a stale release does not trigger effects.

`FileTriggerStore` retains durable job IDs, immutable configuration digests, dedupe keys, due checkpoints and bounded invocation history. It uses local filesystem locks, intent-before-effect and finite leases. Concurrent active invocations report overlap. An expired/crashed lease becomes incomplete and blocks that job for inspection; expiration does not blindly repeat a possibly effective test. Recovery of the application is recorded in a later run, preserving earlier failures. Archive full histories through a host-managed process before their finite limits are exceeded. The file store is for one machine; multiple scheduler hosts need a transactional shared store/lease implementation.

Validation includes actual localhost HTTP failure/recovery, actual hermetic CLI execution, native trace replay, immutable suite/request admission, durable restart dedupe, missed-run policies, overlap, uncertain leases and forged/stale native pipeline events. Browser execution, a production scheduler service and remote provider-specific monitoring are not implied by these local tests.

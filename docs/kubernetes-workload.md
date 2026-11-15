# Container workloads on an existing Kubernetes cluster

`footprintjs-iac/kubernetes-workload` is an opt-in production preparation layer over the existing Kubernetes provider. It has no dependency on kind, Docker Desktop, a particular registry or Neo. Compilation performs no provider calls.

The first profile manages **Deployment and ClusterIP Service** objects only. The namespace, registry credentials, application Secrets, public ConfigMaps, persistent volume claims, database, identity provider and ingress already exist. Referencing those objects neither adopts them nor authorizes their modification. A bound PVC can be mounted; this profile does not provision or migrate storage.

```ts
import {
  compileKubernetesWorkload, GuardedKubernetesAdapter,
  KubernetesExternalReferenceProbe, KubernetesTargetGuard,
  KubectlKubernetesWorkloadTransport,
} from 'footprintjs-iac/kubernetes-workload';
import { KubernetesAdapter } from 'footprintjs-iac';

const { graph, references } = compileKubernetesWorkload({
  stack: 'my-app-production', namespace: 'my-app', name: 'my-app',
  replicas: 1,
  deploymentStrategy: { type: 'Recreate' },
  imagePullSecrets: ['company-registry'],
  podSecurityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
  containers: [{
    name: 'web', image: releaseImageDigest, // registry/repository@sha256:<64 hex>
    ports: [{ name: 'http', containerPort: 3000 }],
    env: {
      NODE_ENV: { configMapKeyRef: { name: 'app-config', key: 'NODE_ENV' } },
      DB_PASSWORD: { secretKeyRef: { name: 'app-secrets', key: 'DB_PASSWORD' } },
    },
    readinessProbe: { httpGet: { path: '/health', port: 'http' } },
    securityContext: { runAsUser: 1000, runAsGroup: 1000 },
    volumeMounts: [{ name: 'uploads', mountPath: '/app/uploads' }],
  }],
  volumes: [{ name: 'uploads', persistentVolumeClaim: { claimName: 'app-uploads' } }],
  service: { ports: [{ name: 'http', port: 80, targetPort: 'http' }] },
});

// A host/operator explicitly registers and pins the existing target ahead of deployment.
// Keep registration and kubeconfig server-side, outside consumer-supplied graph JSON.
const transport = new KubectlKubernetesWorkloadTransport({ context, kubeconfig });
const guard = new KubernetesTargetGuard({ registration, transport });
const probe = new KubernetesExternalReferenceProbe({ namespace: registration.namespace, transport });
const adapter = new GuardedKubernetesAdapter({
  graph, references, guard, probe,
  delegate: new KubernetesAdapter({ context, kubeconfig, namespace: registration.namespace }),
});

// Run this inside a FootPrint stage before the existing change-assessment workflow.
const preflightEvidence = await adapter.preflight();
// Compose the existing MasterWorkflow / InfraEngine with this guarded adapter.
```

Target registration has `{apiServer, caSha256, namespace, namespaceUid}`. `caSha256` is the SHA-256 of the exact explicit CA bundle bytes; an optional `sha256:` prefix is accepted. An endpoint, trust or namespace UID change refuses execution even if a context retains the same name. The guarded adapter's durable provider scope uses this pinned identity, so existing legacy state needs a separately reviewed transition rather than silent reuse.

The host can supply another `KubernetesWorkloadTransport` through `getClusterIdentity(namespace)` and `getReferences(references)`. It must bind transport and executor to the same target. The included kubectl implementation requires an explicit HTTPS CA, rejects insecure TLS, projects only public cluster identity and reference key names, and reads the namespace UID from the API. Its Secret projection excludes values before stdout reaches JavaScript. Credentials and Secret values must never enter graphs, reports, journals or FootPrint context.

The reference probe requires object presence, actual UIDs and all declared key names. Existing PVCs must be Bound. Missing objects, permission failures, absent keys and unknown observations block deployment. Public preflight evidence contains hashes and stable reason codes, not endpoint strings, reference names, values or raw provider errors. Application-specific checks of public ConfigMap values belong in separate read-only consumer stages; generic validation does not know what those values mean.

Guarded execution validates the graph envelope and reconstructs the exact supported manifest shape before any I/O. It refuses raw graph injections such as privileged security settings, host networking, exec probes, hostPath volumes, external Service IPs or unsupported resource kinds. Every provider entry repeats target/reference checks. Apply/remove also inspect ownership and repeat preflight immediately before the delegated effect. Explicit pruning requires separately reviewed prior resources in `allowedRemovals`; no existing resource is adopted automatically. Delegate exceptions are reduced to fixed adapter error codes without stderr, stdout or causes. A failure after an attempted provider write remains uncertain and needs ordinary reconciliation.

Containers default to non-root execution, no privilege escalation, all capabilities dropped, RuntimeDefault seccomp and a read-only root filesystem. Pod service-account token mounting is disabled. Existing Secret/ConfigMap volumes mount read-only; temporary `emptyDir` and existing PVC volumes are supported. Images must use immutable registry digest references. The release/runtime observer must still attest the deployed registry manifest/platform identity: a Docker image ID is not a general substitute for a Kubernetes runtime image ID.

Recreate is the conservative default. It avoids surge overlap for single-writer workloads and creates a brief outage during replacement. An explicitly selected RollingUpdate can declare `maxSurge` and `maxUnavailable` as integers or percentages; both cannot be zero. `replicas: 1` alone never establishes that two pods cannot overlap. Namespace labels do not enforce a firewall or traffic isolation.

These checks are point-in-time evidence. The host should protect its isolated kubeconfig from concurrent retargeting, use versioned/immutable external configuration when possible and verify application connections/login/access after rollout. A target/reference guard cannot make changes across separate Kubernetes API calls atomic, validate application configuration semantics or establish HA. Graph relations describe intended communication; live connection checks supply the evidence that an edge actually works. No cluster bootstrap, ingress/Secret/PVC creation, database migration, remote deployment or CI execution is implicit in this module.

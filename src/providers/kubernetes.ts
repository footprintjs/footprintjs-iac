import { execFile } from 'node:child_process';
import type { Json, JsonObject, Observation, ProviderContext, Resource, ResourceAdapter } from '../types.ts';
import { fingerprint } from '../util.ts';

export interface CommandResult { stdout: string; stderr?: string }
export interface CommandOptions { input?: string; timeoutMs: number }
export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export interface KubernetesOptions {
  context: string;
  namespace?: string;
  kubectl?: string;
  runner?: CommandRunner;
  timeoutMs?: number;
}

const ownerKey = 'footprint-iac.dev/owner';
const stackKey = 'footprint-iac.dev/stack';
const resourceKey = 'footprint-iac.dev/resource';
const manager = 'footprint-iac';
const versions: Record<string, string> = { Namespace: 'v1', ConfigMap: 'v1', Service: 'v1', Deployment: 'apps/v1' };
const plurals: Record<string, string> = { Namespace: 'namespaces', ConfigMap: 'configmaps', Service: 'services', Deployment: 'deployments' };
const dnsName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;

/** Execute kubectl directly. Manifest and DeleteOptions bodies go through stdin, never a shell. */
export const runKubectl: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = execFile(command, [...args], {
    encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) {
      const failure = new Error(`kubectl failed: ${stderr.trim() || error.message}`);
      Object.assign(failure, { cause: error, stderr, stdout });
      reject(failure);
    } else resolve({ stdout, stderr });
  });
  // A child that exits before consuming stdin must still reject through its exit callback.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(options.input);
});

function object(value: Json | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function owner(context: ProviderContext, resource: Resource): string {
  return fingerprint({ stack: context.stack, id: resource.id });
}

function annotations(context: ProviderContext, resource: Resource): JsonObject {
  return { [ownerKey]: owner(context, resource), [stackKey]: context.stack, [resourceKey]: resource.id };
}

/** Compare declared fields, ignoring server defaults, including defaults inside list elements.
 * Lists remain positional and length-sensitive. This prototype does not infer Kubernetes list-map keys.
 */
function declaredProjection(actual: Json | undefined, desired: Json): Json {
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return actual ?? null;
    return actual.map((value, index) => index < desired.length ? declaredProjection(value, desired[index]!) : value);
  }
  if (desired === null || typeof desired !== 'object') return actual ?? null;
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(desired)) result[key] = declaredProjection(object(actual)[key], value);
  return result;
}

/** A conservative field-set overlap check. Unknown/list field encodings refuse migration. */
function fieldsOverlap(fields: Json | undefined, desired: Json | undefined): boolean {
  if (desired === undefined) return false;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return true;
  const entries = Object.entries(fields);
  if (entries.length === 0) return true;
  for (const [key, child] of entries) {
    if (key === '.') continue; // Existing granular-map presence does not change on this apply.
    if (!key.startsWith('f:')) return true;
    const name = key.slice(2);
    if (desired === null || typeof desired !== 'object' || Array.isArray(desired)) return true;
    if (Object.hasOwn(desired, name) && fieldsOverlap(child, desired[name])) return true;
  }
  return false;
}

/**
 * A POST/create manager is an Update manager, distinct from the same name's Apply manager.
 * Only migrate our own bootstrap ownership; never force a foreign manager's requested fields.
 * The apply body also carries the exact observed UID/resourceVersion, protecting this check
 * from any intervening mutation (including a new field manager or a same-name replacement).
 */
function canMigrateBootstrap(live: JsonObject, desired: JsonObject): boolean {
  const managed = object(live.metadata).managedFields;
  if (!Array.isArray(managed) || managed.length === 0) return false;
  let ownBootstrap = false;
  for (const item of managed) {
    const entry = object(item);
    if (typeof entry.manager !== 'string' || !['Apply', 'Update'].includes(String(entry.operation))
      || entry.fieldsType !== 'FieldsV1' || !entry.fieldsV1 || typeof entry.fieldsV1 !== 'object'
      || Array.isArray(entry.fieldsV1)) return false;
    const mainResource = entry.subresource === undefined || entry.subresource === '';
    if (entry.manager === manager) {
      if (mainResource && entry.operation === 'Update' && entry.apiVersion === live.apiVersion) ownBootstrap = true;
      continue;
    }
    // Status writers sometimes also own metadata annotations. Check their actual field set.
    if (entry.subresource !== 'status' || fieldsOverlap(entry.fieldsV1, desired)) return false;
  }
  return ownBootstrap;
}

interface Target { kind: string; name: string; namespace?: string; path: string }

/**
 * Narrow Kubernetes adapter for a local IaC prototype.
 * Uses explicit contexts/namespaces, verified ownership, conditional mutations, and API readiness.
 * Namespace deletion is intentionally unsupported because it cascades into unrelated resources.
 */
export class KubernetesAdapter implements ResourceAdapter {
  readonly name = 'kubernetes';
  readonly supportsSafeRetry = true;
  readonly scope: string;
  private readonly options: KubernetesOptions;
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(options: KubernetesOptions) {
    if (!options.context?.trim() || options.context.startsWith('-')) throw new Error('An explicit Kubernetes context is required.');
    if (options.namespace !== undefined && !dnsName.test(options.namespace)) throw new Error('Invalid Kubernetes namespace.');
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('timeoutMs must be positive.');
    this.options = options;
    this.scope = JSON.stringify({ context: options.context, namespace: options.namespace ?? null });
    this.runner = options.runner ?? runKubectl;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private target(resource: Resource): Target {
    const spec = resource.spec;
    const kind = String(spec.kind ?? '');
    if (!Object.hasOwn(versions, kind) || spec.apiVersion !== versions[kind]) {
      throw new Error(`Unsupported Kubernetes kind/version: ${String(spec.apiVersion)}/${kind}. Supported: Namespace, ConfigMap, Service, Deployment.`);
    }
    if (Object.hasOwn(spec, 'status')) throw new Error('Desired Kubernetes manifests must not include status.');
    const metadata = object(spec.metadata);
    const name = typeof metadata.name === 'string' ? metadata.name : '';
    if (!dnsName.test(name) || name.length > 253) throw new Error('A valid explicit metadata.name is required; generateName is unsupported.');
    for (const key of ['uid', 'resourceVersion', 'managedFields', 'generation', 'creationTimestamp', 'deletionTimestamp']) {
      if (Object.hasOwn(metadata, key)) throw new Error(`Desired metadata must not contain runtime field ${key}.`);
    }
    const desiredAnnotations = object(metadata.annotations);
    for (const key of [ownerKey, stackKey, resourceKey]) {
      if (Object.hasOwn(desiredAnnotations, key)) throw new Error(`Annotation ${key} is reserved for framework ownership.`);
    }
    if (kind === 'Namespace') {
      if (name === 'default' || name.startsWith('kube-')) throw new Error(`Refusing to manage reserved namespace ${name}.`);
      if (metadata.namespace !== undefined) throw new Error('Namespace manifests cannot specify metadata.namespace.');
      if (this.options.namespace && name !== this.options.namespace) throw new Error('Namespace name differs from the configured namespace.');
      return { kind, name, path: `/api/v1/namespaces/${encodeURIComponent(name)}` };
    }
    const namespace = metadata.namespace ?? this.options.namespace;
    if (typeof namespace !== 'string' || !dnsName.test(namespace)) throw new Error('Namespaced resources require an explicit namespace in the manifest or adapter.');
    if (this.options.namespace && namespace !== this.options.namespace) throw new Error('Resource namespace differs from the configured namespace.');
    const prefix = kind === 'Deployment' ? '/apis/apps/v1' : '/api/v1';
    return { kind, name, namespace, path: `${prefix}/namespaces/${encodeURIComponent(namespace)}/${plurals[kind]}/${encodeURIComponent(name)}` };
  }

  private command(args: string[], target?: Target, input?: string): Promise<CommandResult> {
    const seconds = `${Math.max(1, Math.ceil(this.timeoutMs / 1000))}s`;
    const base = ['--context', this.options.context, '--request-timeout', seconds];
    if (target?.namespace) base.push('--namespace', target.namespace);
    return this.runner(this.options.kubectl ?? 'kubectl', [...base, ...args], { timeoutMs: this.timeoutMs + 1000, ...(input === undefined ? {} : { input }) });
  }

  private async read(resource: Resource): Promise<JsonObject | undefined> {
    const target = this.target(resource);
    const result = await this.command(['get', target.kind, target.name, '--ignore-not-found=true', '--show-managed-fields=true', '-o', 'json'], target);
    if (!result.stdout.trim()) return undefined;
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Kubernetes returned an invalid resource object.');
    const live = parsed as JsonObject;
    const metadata = object(live.metadata);
    if (live.kind !== target.kind || live.apiVersion !== versions[target.kind] || metadata.name !== target.name || (target.namespace && metadata.namespace !== target.namespace)) {
      throw new Error('Kubernetes returned a different resource identity.');
    }
    return live;
  }

  private owned(live: JsonObject, resource: Resource, context: ProviderContext): boolean {
    const marks = object(object(live.metadata).annotations);
    return marks[ownerKey] === owner(context, resource) && marks[stackKey] === context.stack && marks[resourceKey] === resource.id;
  }

  private ready(live: JsonObject, resource: Resource): boolean {
    const target = this.target(resource);
    const metadata = object(live.metadata);
    if (metadata.deletionTimestamp) return false;
    const status = object(live.status);
    if (target.kind === 'Namespace') return status.phase === 'Active';
    if (target.kind === 'Deployment') {
      const replicas = Number(object(resource.spec.spec).replicas ?? 1);
      return Number(status.observedGeneration ?? -1) >= Number(metadata.generation ?? 0)
        && Number(status.updatedReplicas ?? 0) === replicas
        && Number(status.availableReplicas ?? 0) >= replicas
        && Number(status.replicas ?? 0) === replicas;
    }
    if (target.kind === 'Service' && object(resource.spec.spec).type === 'LoadBalancer') {
      const ingress = object(status.loadBalancer).ingress;
      return Array.isArray(ingress) && ingress.length > 0;
    }
    return true;
  }

  async observe(resource: Resource, context: ProviderContext): Promise<Observation> {
    const target = this.target(resource);
    // The prospective API address is stable before create and across replacements.
    // UID remains a mutation/delete precondition, rather than the planner's identity.
    const physicalId = `kubernetes://${encodeURIComponent(this.options.context)}${target.path}`;
    const live = await this.read(resource);
    if (!live) return { exists: false, physicalId };
    return {
      exists: true,
      fingerprint: fingerprint(declaredProjection(live, resource.spec)),
      physicalId,
      owned: this.owned(live, resource, context),
      ready: this.ready(live, resource),
    };
  }

  async apply(resource: Resource, context: ProviderContext): Promise<void> {
    const target = this.target(resource);
    const live = await this.read(resource);
    if (live && !this.owned(live, resource, context)) throw new Error(`Refusing to modify unowned Kubernetes resource ${target.kind}/${target.name}.`);
    const desired = structuredClone(resource.spec);
    const metadata = object(desired.metadata);
    desired.metadata = metadata;
    if (target.namespace) metadata.namespace = target.namespace;
    metadata.annotations = { ...object(metadata.annotations), ...annotations(context, resource) };
    if (live) {
      const current = object(live.metadata);
      if (typeof current.uid !== 'string' || typeof current.resourceVersion !== 'string') throw new Error('Owned Kubernetes resource lacks mutation preconditions.');
      // These are API preconditions: a replacement or concurrent change rejects the operation.
      metadata.uid = current.uid;
      metadata.resourceVersion = current.resourceVersion;
      const args = ['apply', '--server-side=true', '--field-manager', manager, '-f', '-', '-o', 'json'];
      const body = JSON.stringify(desired);
      try {
        await this.command(args, target, body);
      } catch (error) {
        if (!(error instanceof Error) || !/\bconflict\b/i.test(error.message) || !canMigrateBootstrap(live, desired)) throw error;
        // Bounded one-time Update→Apply migration. Stale preconditions or any foreign
        // main-resource ownership make this fail rather than taking another writer's work.
        await this.command([...args, '--force-conflicts=true'], target, body);
      }
    } else {
      // A create conflicts rather than claiming an unowned object that races the preceding read.
      await this.command(['create', '--field-manager', manager, '-f', '-', '-o', 'json'], target, JSON.stringify(desired));
    }
  }

  async remove(resource: Resource, context: ProviderContext): Promise<void> {
    const target = this.target(resource);
    if (target.kind === 'Namespace') throw new Error('Namespace deletion is unsupported; remove it separately after reviewing its contents.');
    const live = await this.read(resource);
    if (!live) return;
    if (!this.owned(live, resource, context)) throw new Error(`Refusing to delete unowned Kubernetes resource ${target.kind}/${target.name}.`);
    const metadata = object(live.metadata);
    if (typeof metadata.uid !== 'string' || typeof metadata.resourceVersion !== 'string') throw new Error('Owned Kubernetes resource lacks deletion preconditions.');
    const body = JSON.stringify({
      apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground',
      preconditions: { uid: metadata.uid, resourceVersion: metadata.resourceVersion },
    });
    try {
      await this.command(['delete', '--raw', target.path, '-f', '-'], target, body);
    } catch (error) {
      // Only API NotFound is an already-deleted resource; permissions/transport failures propagate.
      if (!(error instanceof Error) || !/\(NotFound\)/.test(error.message)) throw error;
    }
    await this.command(['wait', '--for=delete', `${target.kind}/${target.name}`, `--timeout=${Math.ceil(this.timeoutMs / 1000)}s`], target);
  }

  async waitReady(resource: Resource, context: ProviderContext): Promise<void> {
    const target = this.target(resource);
    const live = await this.read(resource);
    if (!live || !this.owned(live, resource, context)) throw new Error(`Resource ${target.kind}/${target.name} is missing or no longer owned.`);
    if (target.kind === 'Deployment') {
      await this.command(['rollout', 'status', `deployment/${target.name}`, `--timeout=${Math.ceil(this.timeoutMs / 1000)}s`], target);
    } else if (target.kind === 'Namespace') {
      await this.command(['wait', '--for=jsonpath={.status.phase}=Active', `namespace/${target.name}`, `--timeout=${Math.ceil(this.timeoutMs / 1000)}s`], target);
    } else if (target.kind === 'Service' && object(resource.spec.spec).type === 'LoadBalancer') {
      await this.command(['wait', '--for=jsonpath={.status.loadBalancer.ingress}', `service/${target.name}`, `--timeout=${Math.ceil(this.timeoutMs / 1000)}s`], target);
    }
    const final = await this.read(resource);
    if (!final || !this.owned(final, resource, context) || !this.ready(final, resource)) throw new Error(`Resource ${target.kind}/${target.name} did not become ready.`);
  }
}

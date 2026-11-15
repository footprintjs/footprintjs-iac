import { freeze } from '../graph/data.ts';
import { readHostRef } from '../platform-access/data.ts';
import type { HostAccessTransport, HostActionDescriptor, HostRef } from '../platform-access/types.ts';
import { fingerprint } from '../util.ts';
import { digest, identifier, readBootstrapIntent } from './data.ts';
import { ClusterBootstrapAdapterError } from './errors.ts';
import { conservativeClusterBootstrapStrategy } from './strategy.ts';
import type { BootstrapIntent, ClusterBootstrapStrategy, ClusterConnectionPort, HostPreparationPort } from './types.ts';

export interface KubeadmHostRegistration {
  hostId: string;
  transport: HostAccessTransport;
  preparation: HostPreparationPort;
  initializeActionId?: string;
  joinActionId?: string;
}
export interface KubeadmClusterAdapterOptions {
  id: string;
  scope: string;
  intent: BootstrapIntent;
  hosts: readonly KubeadmHostRegistration[];
  /** Registered CNI action on the first control-plane host. Kubernetes API health alone is insufficient. */
  networkActionId?: string;
  connection: ClusterConnectionPort;
  strategy?: ClusterBootstrapStrategy;
  maxObservationAgeMs?: number;
  maxFutureSkewMs?: number;
  minimums?: { controlPlaneCpu?: number; workerCpu?: number; totalMemoryBytes?: number; availableMemoryBytes?: number; availableDiskBytes?: number };
}
export interface RegisteredKubeadmHost extends KubeadmHostRegistration { host: HostRef; descriptors: readonly HostActionDescriptor[] }
export interface RegisteredKubeadmConfiguration {
  id: string; scope: string; intent: BootstrapIntent; hosts: readonly RegisteredKubeadmHost[];
  networkActionId?: string; connection: ClusterConnectionPort; strategy: ClusterBootstrapStrategy;
  minimums: Required<NonNullable<KubeadmClusterAdapterOptions['minimums']>>; digest: string;
  maxObservationAgeMs: number; maxFutureSkewMs: number;
}
export function descriptors(transport: HostAccessTransport): HostActionDescriptor[] {
  const values = transport.actions();
  if (!Array.isArray(values) || values.length > 64) throw new ClusterBootstrapAdapterError('invalid-bootstrap-actions');
  const result = values.map(value => {
    if (!value || Object.keys(value).some(key => !['id', 'digest', 'effect'].includes(key)) || !['mutating', 'read-only'].includes(value.effect)) throw new ClusterBootstrapAdapterError('invalid-bootstrap-actions');
    return { id: identifier(value.id), digest: digest(value.digest), effect: value.effect };
  });
  if (new Set(result.map(value => value.id)).size !== result.length) throw new ClusterBootstrapAdapterError('invalid-bootstrap-actions');
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
export function registerKubeadmConfiguration(options: KubeadmClusterAdapterOptions): RegisteredKubeadmConfiguration {
  const id = identifier(options.id), scope = identifier(options.scope), intent = readBootstrapIntent(options.intent);
  if (!Array.isArray(options.hosts) || options.hosts.length > 128 || new Set(options.hosts.map(host => host.hostId)).size !== options.hosts.length) throw new ClusterBootstrapAdapterError('invalid-bootstrap-hosts');
  const selectedStrategy = options.strategy ?? conservativeClusterBootstrapStrategy();
  const strategy = Object.freeze({ id: identifier(selectedStrategy.id), digest: digest(selectedStrategy.digest), assess: selectedStrategy.assess.bind(selectedStrategy) });
  const maxObservationAgeMs = options.maxObservationAgeMs ?? 30000, maxFutureSkewMs = options.maxFutureSkewMs ?? 1000;
  if (!Number.isInteger(maxObservationAgeMs) || maxObservationAgeMs < 100 || maxObservationAgeMs > 300000
    || !Number.isInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 || maxFutureSkewMs > 5000) throw new ClusterBootstrapAdapterError('invalid-bootstrap-freshness');
  const minimums = { controlPlaneCpu: 2, workerCpu: 1, totalMemoryBytes: 2 * 1024 ** 3, availableMemoryBytes: 1024 ** 3, availableDiskBytes: 10 * 1024 ** 3, ...options.minimums };
  if (Object.keys(minimums).some(key => !['controlPlaneCpu', 'workerCpu', 'totalMemoryBytes', 'availableMemoryBytes', 'availableDiskBytes'].includes(key))
    || Object.values(minimums).some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new ClusterBootstrapAdapterError('invalid-bootstrap-minimums');
  const hosts = options.hosts.map(value => {
    const host = readHostRef(value.transport.host);
    if (host.id !== identifier(value.hostId) || !value.preparation || typeof value.preparation.inspect !== 'function') throw new ClusterBootstrapAdapterError('invalid-bootstrap-hosts');
    identifier(value.transport.id); identifier(value.preparation.id); digest(value.preparation.recipeDigest);
    const transport = Object.freeze({ id: value.transport.id, host, actions: value.transport.actions.bind(value.transport), run: value.transport.run.bind(value.transport) });
    const preparation = Object.freeze({ id: value.preparation.id, recipeDigest: value.preparation.recipeDigest, inspect: value.preparation.inspect.bind(value.preparation) });
    return { hostId: host.id, transport, preparation, host, descriptors: freeze(descriptors(transport)),
      ...(value.initializeActionId ? { initializeActionId: identifier(value.initializeActionId) } : {}),
      ...(value.joinActionId ? { joinActionId: identifier(value.joinActionId) } : {}) };
  });
  const captured = { id, scope, intent, minimums, maxObservationAgeMs, maxFutureSkewMs, ...(options.networkActionId ? { networkActionId: identifier(options.networkActionId) } : {}),
    strategy: { id: strategy.id, digest: strategy.digest },
    hosts: hosts.map(value => ({ host: value.host, transportId: value.transport.id, descriptors: value.descriptors, preparationId: value.preparation.id,
      recipeDigest: value.preparation.recipeDigest, ...(value.initializeActionId ? { initializeActionId: value.initializeActionId } : {}),
      ...(value.joinActionId ? { joinActionId: value.joinActionId } : {}) })) };
  const connection = Object.freeze({ inspect: options.connection.inspect.bind(options.connection), publishAccess: options.connection.publishAccess.bind(options.connection), verify: options.connection.verify.bind(options.connection) });
  return { id, scope, intent, minimums: freeze(minimums), hosts, connection, strategy, maxObservationAgeMs, maxFutureSkewMs,
    ...(options.networkActionId ? { networkActionId: options.networkActionId } : {}), digest: fingerprint(captured) };
}

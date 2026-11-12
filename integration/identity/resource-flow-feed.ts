import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplyResult } from '../../src/engine.ts';
import type { InfraGraph } from '../../src/graph/types.ts';
import { freeze } from '../../src/graph/data.ts';
import type { DeploymentRecorder, DeploymentSnapshot } from '../../src/progress/types.ts';
import type { ConnectionRunResult, ConnectionSnapshot } from '../../src/connections/types.ts';
import type { IdentityRunResult, IdentitySnapshot } from '../../src/identity/types.ts';
import type { ResourceFlowContext, ResourceFlowState } from '../../src/resource-flow/types.ts';
import type { ResourceFlowWorkflow } from '../../src/resource-flow/node.ts';
import { canonical } from '../../src/util.ts';
import { neoIdentityChecks } from './checks.ts';
import type { IdentityTarget } from './target.ts';
import { writeNeoFlowJson } from './resource-flow-files.ts';
import { restoreConnections, restoreDeployment, restoreIdentity } from './resource-flow-rehydrate.ts';
import { publicConnections, publicDeployment, publicIdentity } from './resource-flow-project.ts';
import { neoFlowPhysicalId, type NeoFlowIdentityObservation } from './resource-flow-observation.ts';
import type { NeoFlowApplyObservation, NeoFlowConnectionObservation, NeoFlowCorrelation, NeoFlowIdentityObservationFeed,
  NeoFlowSourceObservation, NeoResourceFlowObservation, NeoResourceFlowObservationSource } from './resource-flow-view.ts';

type Phase = 'acquire' | 'connect';
type Reference = { kind: Phase | 'connections' | 'identity'; runId: string; correlation: NeoFlowCorrelation };
const runId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

/** Fixed evidence reader and isolated native-recorder subscribers. It never invokes an adapter. */
export class NeoResourceFlowFeed implements NeoResourceFlowObservationSource {
  private parent!: ResourceFlowState;
  private sequence = 0;
  private subscriberFailures = 0;
  private retentionFailed = false;
  private retainedEvidence: NeoResourceFlowObservation['retainedEvidence'] = 'none';
  private deployments: NeoFlowApplyObservation[] = [];
  private source?: NeoFlowSourceObservation;
  private connections: NeoFlowConnectionObservation[] = [];
  private identities: NeoFlowIdentityObservationFeed[] = [];
  private references: Reference[] = [];
  private active?: { phase: Phase; context: ResourceFlowContext };
  private readonly listeners = new Set<(snapshot: NeoResourceFlowObservation) => void>();
  private pending = Promise.resolve();
  private readonly target: IdentityTarget;
  private readonly directory: string;
  private readonly graphs: { acquire: InfraGraph; connect: InfraGraph; system: InfraGraph };
  constructor(target: IdentityTarget, directory: string, graphs: { acquire: InfraGraph; connect: InfraGraph; system: InfraGraph }) {
    this.target = target; this.directory = directory; this.graphs = graphs;
  }
  async attach(workflow: ResourceFlowWorkflow, recorder: DeploymentRecorder): Promise<void> {
    this.parent = await workflow.snapshot();
    await this.restore();
    workflow.subscribe(state => { this.parent = state; this.publish(); });
    recorder.subscribeChart(() => this.applyProgress(recorder.getSnapshot()));
    recorder.subscribe(() => this.applyProgress(recorder.getSnapshot()));
  }
  async snapshot(): Promise<NeoResourceFlowObservation> { return this.current(); }
  subscribe(listener: (snapshot: NeoResourceFlowObservation) => void): () => void {
    if (typeof listener !== 'function') throw Error('A Neo observation listener must be callable');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private current(): NeoResourceFlowObservation {
    let source = this.source;
    const acquired = this.parent.events.find(event => event.stageId === 'acquire' && event.status === 'passed');
    if (source && acquired) source = { ...source, parentAcquire: { runtimeStageId: acquired.runtimeStageId,
      ...(this.parent.segments[0] ? { runId: this.parent.segments[0].runId } : {}) } };
    return freeze(structuredClone({ version: 1, kind: 'neo-resource-flow-observation', targetId: this.target.id,
      sequence: this.sequence, parent: this.parent, deployments: this.deployments, ...(source ? { source } : {}),
      connections: this.connections, identities: this.identities, retainedEvidence: this.retainedEvidence,
      subscriberFailures: this.subscriberFailures }) as NeoResourceFlowObservation);
  }
  private publish(): void {
    this.sequence++;
    for (const listener of this.listeners) { try { listener(this.current()); } catch { this.subscriberFailures++; } }
  }
  beginApply(phase: Phase, context: ResourceFlowContext): void { this.active = { phase, context }; }
  private applyProgress(snapshot: DeploymentSnapshot): void {
    if (!this.active || !snapshot.runId) return;
    const { phase, context } = this.active;
    const row: NeoFlowApplyObservation = { phase, executionId: context.executionId,
      definitionDigest: context.definitionDigest, origin: 'live', snapshot: publicDeployment(snapshot) };
    const existing = this.deployments.findIndex(value => value.snapshot.runId === snapshot.runId);
    if (existing < 0) this.deployments.push(row); else this.deployments[existing] = row;
    this.publish();
  }
  async completeApply(phase: Phase, context: ResourceFlowContext, snapshot: DeploymentSnapshot, result: ApplyResult): Promise<void> {
    const row = this.applyRow(phase, context, snapshot, result, 'live');
    this.deployments = [...this.deployments.filter(value => value.snapshot.runId !== result.runId), row];
    this.active = undefined;
    this.retain({ kind: phase, runId: result.runId, correlation: { executionId: context.executionId, definitionDigest: context.definitionDigest, purpose: 'verify' } });
    this.publish(); await this.flush();
  }
  async observeSource(observation: NeoFlowIdentityObservation, context: ResourceFlowContext): Promise<void> {
    // Keep the first actual acquired identity/time. Later validation cannot rewrite acquisition history.
    if (this.source) return;
    this.source = { mode: this.parent.mode, executionId: context.executionId, definitionDigest: context.definitionDigest,
      physicalId: neoFlowPhysicalId(observation), observedAt: Date.now(), resources: [
        { resourceId: 'identity-directory', physicalId: observation.directory.id, running: observation.directory.running },
        { resourceId: 'identity-provider', physicalId: observation.provider.id, running: observation.provider.running }] };
    this.save(); this.publish(); await this.flush();
  }
  captureConnections(correlation: NeoFlowCorrelation, snapshot: ConnectionSnapshot, result?: ConnectionRunResult): void {
    if (!snapshot.runId) return;
    const row: NeoFlowConnectionObservation = { ...correlation, origin: 'live', snapshot: publicConnections(snapshot),
      ...(result ? { result: this.checkResult(result, 'connections') } : {}) };
    this.connections = [...this.connections.filter(value => value.snapshot.runId !== snapshot.runId), row];
    if (result) this.retain({ kind: 'connections', runId: result.runId, correlation }); this.publish();
  }
  captureIdentity(correlation: NeoFlowCorrelation, snapshot: IdentitySnapshot, result?: IdentityRunResult): void {
    if (!snapshot.runId) return;
    const row: NeoFlowIdentityObservationFeed = { ...correlation, origin: 'live', snapshot: publicIdentity(snapshot),
      ...(result ? { result: this.checkResult(result, 'identity') } : {}) };
    this.identities = [...this.identities.filter(value => value.snapshot.runId !== snapshot.runId), row];
    if (result) this.retain({ kind: 'identity', runId: result.runId, correlation }); this.publish();
  }
  async flush(): Promise<void> { await this.pending; }
  private retain(reference: Reference): void {
    if (!this.references.some(value => value.runId === reference.runId)) this.references.push(reference);
    this.retainedEvidence = this.retentionFailed ? 'incomplete' : 'complete'; this.save();
  }
  private save(): void {
    const envelope = structuredClone({ version: 1, target: this.parent.target, definitionDigest: this.parent.definitionDigest,
      configurationDigest: this.parent.configurationDigest, executionId: this.parent.executionId,
      source: this.source, references: this.references });
    this.pending = this.pending.then(() => writeNeoFlowJson(join(this.directory, 'observer.json'), envelope))
      .catch(() => { this.retentionFailed = true; this.retainedEvidence = 'incomplete'; this.publish(); });
  }
  private applyRow(phase: Phase, context: Pick<ResourceFlowContext, 'executionId' | 'definitionDigest'>,
    snapshot: DeploymentSnapshot, result: ApplyResult, origin: 'live' | 'evidence'): NeoFlowApplyObservation {
    const graph = this.graphs[phase];
    if (snapshot.runId !== result.runId || snapshot.chart?.graphDigest !== graph.digest
      || canonical(snapshot.chart.resources.map(value => value.resourceId).sort()) !== canonical(graph.resources.map(value => value.id).sort())
      || canonical(result.plan.operations.map(operation => ({ id: operation.resource.id, action: operation.action })).sort((a, b) => a.id.localeCompare(b.id)))
        !== canonical(snapshot.chart.resources.map(resource => ({ id: resource.resourceId, action: resource.action })).sort((a, b) => a.id.localeCompare(b.id)))) throw Error('Native child observation does not match its fixed graph');
    return { phase, executionId: context.executionId, definitionDigest: context.definitionDigest, origin, snapshot: publicDeployment(snapshot), result: { ok: result.ok, runId: result.runId,
      evidencePath: result.evidencePath, ...(result.tracePath ? { tracePath: result.tracePath } : {}),
      actions: result.plan.operations.map(operation => ({ resourceId: operation.resource.id, action: operation.action })),
      chartPublished: result.chartStatus?.published === true && result.chartStatus.failed === 0,
      traceFlushed: result.traceStatus?.flushed === true && result.traceStatus.failed === 0 } };
  }
  private checkResult(result: ConnectionRunResult | IdentityRunResult, kind: 'connections' | 'identity') {
    return { ok: result.ok, runId: result.runId, evidencePath: join(this.directory, kind, result.runId + '.json'),
      ...(result.tracePath ? { tracePath: result.tracePath } : {}),
      traceFlushed: result.traceStatus?.flushed === true && result.traceStatus.failed === 0 };
  }
  private async restore(): Promise<void> {
    let envelope: any;
    try { envelope = JSON.parse(await readFile(join(this.directory, 'observer.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.retentionFailed = true; this.retainedEvidence = 'incomplete'; return; }
      // Older completed flows already pin their child receipts. Reuse only those fixed files; a missing
      // source observation stays unknown and is never reconstructed by contacting a provider.
      if (!this.parent.executionId) return;
      const correlation = { executionId: this.parent.executionId, definitionDigest: this.parent.definitionDigest, purpose: 'verify' as const };
      const references: Reference[] = [];
      for (const [kind, receipt] of [['acquire', this.parent.resource?.receipt], ['connect', this.parent.connection]] as const) {
        if (receipt?.runId) references.push({ kind, runId: receipt.runId, correlation });
      }
      const failed = this.parent.failure;
      if ((failed?.stageId === 'acquire' || failed?.stageId === 'connect') && failed.receipt?.runId
        && !references.some(value => value.runId === failed.receipt!.runId)) references.push({ kind: failed.stageId, runId: failed.receipt.runId, correlation });
      for (const receipt of this.parent.verification?.receipts ?? []) {
        const kind = receipt.id === 'neo-connections' ? 'connections' : receipt.id === 'neo-access' ? 'identity' : undefined;
        if (kind && receipt.runId) references.push({ kind, runId: receipt.runId, correlation });
      }
      if (!references.length) return;
      envelope = { version: 1, target: this.parent.target, definitionDigest: this.parent.definitionDigest,
        configurationDigest: this.parent.configurationDigest, executionId: this.parent.executionId, references };
    }
    try {
      if (envelope.version !== 1 || envelope.definitionDigest !== this.parent.definitionDigest
        || envelope.configurationDigest !== this.parent.configurationDigest || envelope.executionId !== this.parent.executionId
        || canonical(envelope.target) !== canonical(this.parent.target) || !Array.isArray(envelope.references)) throw Error();
      if (envelope.source) {
        const source = envelope.source as NeoFlowSourceObservation;
        if (source.executionId !== this.parent.executionId || source.definitionDigest !== this.parent.definitionDigest
          || source.mode !== this.parent.mode || source.physicalId !== this.parent.resource?.physicalId
          || !Number.isFinite(source.observedAt) || source.observedAt < 0
          || source.resources.length !== 2 || source.resources[0]?.resourceId !== 'identity-directory'
          || source.resources[1]?.resourceId !== 'identity-provider'
          || source.resources.some(value => !/^[a-f0-9]{64}$/.test(value.physicalId) || typeof value.running !== 'boolean')
          || neoFlowPhysicalId({ directory: { id: source.resources[0].physicalId } as any,
            provider: { id: source.resources[1].physicalId } as any }) !== source.physicalId) throw Error();
        this.source = { mode: source.mode, executionId: source.executionId, definitionDigest: source.definitionDigest,
          physicalId: source.physicalId, observedAt: source.observedAt, resources: source.resources.map(({ resourceId, physicalId, running }) => ({ resourceId, physicalId, running })) };
      }
      for (const reference of envelope.references as Reference[]) {
        const { correlation } = reference;
        if (!runId(reference.runId) || !['acquire', 'connect', 'connections', 'identity'].includes(reference.kind)
          || correlation.executionId !== this.parent.executionId || correlation.definitionDigest !== this.parent.definitionDigest
          || !['verify', 'recheck'].includes(correlation.purpose)) throw Error();
        const context = { executionId: correlation.executionId, definitionDigest: correlation.definitionDigest };
        if (reference.kind === 'acquire' || reference.kind === 'connect') {
          const saved = JSON.parse(await readFile(join(this.directory, 'infra', reference.runId + '.json'), 'utf8'));
          const receipt = reference.kind === 'acquire' ? this.parent.resource?.receipt ?? (this.parent.failure?.stageId === 'acquire' ? this.parent.failure.receipt : undefined) : this.parent.connection ?? this.parent.failure?.receipt;
          if (saved.phase !== reference.kind || saved.result.runId !== reference.runId || canonical(saved.graph) !== canonical(this.graphs[reference.kind])
            || receipt?.runId !== reference.runId || receipt.evidencePath !== saved.result.evidencePath) throw Error();
          const evidencePath = join(this.target.stateDirectory, 'run-' + createHash('sha256').update(reference.runId).digest('hex') + '.json');
          if (saved.result.evidencePath !== evidencePath) throw Error();
          const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
          const snapshot = restoreDeployment(evidence.deploymentChart, saved.events);
          if (saved.snapshot && canonical(publicDeployment(saved.snapshot)) !== canonical(publicDeployment(snapshot))) throw Error();
          if (evidence.runId !== reference.runId || canonical(evidence.graph) !== canonical(this.graphs[reference.kind])
            || saved.result.ok !== !evidence.snapshot.sharedState.failure
            || canonical(saved.result.failure) !== canonical(evidence.snapshot.sharedState.failure)) throw Error();
          this.deployments.push(this.applyRow(reference.kind, context, snapshot, saved.result, 'evidence'));
        } else {
          const saved = JSON.parse(await readFile(join(this.directory, reference.kind, reference.runId + '.json'), 'utf8'));
          if (saved.runId !== reference.runId || saved.stack !== this.graphs.system.name
            || saved.events.some((event: any) => event.runId !== reference.runId)
            || canonical(saved.checks) !== canonical(saved.snapshot?.sharedState?.checks)
            || saved.ok !== saved.snapshot?.sharedState?.ok
            || (reference.kind === 'connections' && canonical(saved.graph) !== canonical(this.graphs.system))) throw Error();
          const expectedIds = reference.kind === 'identity' ? neoIdentityChecks.map(check => check.id)
            : this.graphs.system.relations.flatMap((relation, index) => relation.kind === 'communicatesWith' ? ['communication:' + index] : []);
          if (canonical(Object.keys(saved.checks).sort()) !== canonical(expectedIds.sort())) throw Error();
          if (reference.kind === 'connections') this.connections.push({ ...correlation, origin: 'evidence',
            snapshot: publicConnections(restoreConnections(saved.runId, saved.events)), result: this.checkResult(saved, 'connections') });
          else this.identities.push({ ...correlation, origin: 'evidence', snapshot: publicIdentity(restoreIdentity(saved.runId, saved.events)), result: this.checkResult(saved, 'identity') });
        }
        this.references.push(reference);
      }
      this.retainedEvidence = 'complete';
    } catch { this.retentionFailed = true; this.retainedEvidence = 'incomplete'; }
  }
}

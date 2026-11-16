import { assertExecutableGraph, validateInfraGraph } from '../graph/validation.ts';
import type { Observation, ProviderContext, Resource, ResourceAdapter } from '../types.ts';
import { fingerprint } from '../util.ts';
import { kubernetesWorkloadReferences } from './compile.ts';
import { KubernetesWorkloadAdapterError, KubernetesWorkloadPreflightError } from './errors.ts';
import { mergeKubernetesReferences } from './references.ts';
import type { GuardedKubernetesAdapterOptions, KubernetesExternalReference, KubernetesWorkloadPreflight } from './types.ts';
import { createAdapterFlowChart } from '../adapter-flow/create-chart.ts';

const resourceDigest = (resource: Resource) => fingerprint({ id: resource.id, provider: resource.provider, spec: resource.spec });

/** An opt-in guard around the existing provider; it does not alter legacy KubernetesAdapter behavior.
 * Host composition must bind delegate and guard transport to the same isolated credentials/target.
 */
export class GuardedKubernetesAdapter implements ResourceAdapter {
  readonly name = 'kubernetes';
  readonly scope: string;
  readonly supportsSafeRetry: boolean;
  readonly createApplyFlow?:ResourceAdapter['createApplyFlow'];
  readonly createVerifyFlow?:ResourceAdapter['createVerifyFlow'];
  private readonly options: GuardedKubernetesAdapterOptions;
  private readonly stack: string;
  private readonly graphDigest: string;
  private readonly desired: ReadonlySet<string>;
  private readonly removals: ReadonlySet<string>;
  private readonly references: readonly KubernetesExternalReference[];

  constructor(options: GuardedKubernetesAdapterOptions) {
    const graph = validateInfraGraph(options.graph);
    assertExecutableGraph(graph);
    if (options.delegate.name !== 'kubernetes' || options.guard.namespace !== options.probe.namespace) throw new Error('Guarded workload requires one Kubernetes provider and one registered namespace.');
    const namespace = options.guard.namespace;
    const extracted = kubernetesWorkloadReferences(graph.resources, namespace, graph.name);
    const removals = structuredClone(options.allowedRemovals ?? []);
    kubernetesWorkloadReferences(removals, namespace, graph.name);
    this.options = { delegate: options.delegate, graph, guard: options.guard, probe: options.probe };
    this.stack = graph.name;
    this.graphDigest = graph.digest;
    this.desired = new Set(graph.resources.map(resourceDigest));
    this.removals = new Set(removals.map(resourceDigest));
    this.references = mergeKubernetesReferences([...extracted, ...(options.references ?? [])], namespace);
    this.scope = options.guard.scope;
    this.supportsSafeRetry = options.delegate.supportsSafeRetry === true;
    if(options.delegate.createApplyFlow)this.createApplyFlow=(resource,context,binding)=>{
      const selected=this.admit(resource,context,'apply'),selectedContext={...context};
      const child=options.delegate.createApplyFlow!(selected,selectedContext,binding);
      return createAdapterFlowChart(binding,[
        {id:'guard-target',name:'Verify pinned Kubernetes target and references',phase:'revalidate',run:async()=>{await this.preflight();}},
        {id:'guard-owner',name:'Verify declared workload ownership',phase:'inspect',run:async()=>{const observed=await this.delegateObserve(selected,selectedContext);if(observed.exists&&observed.owned!==true)throw Error('workload-unowned');}},
        {id:'guard-revalidate',name:'Revalidate pinned target before mutation',phase:'revalidate',run:async()=>{await this.preflight();}},
      ],child);
    };
    if(options.delegate.createVerifyFlow)this.createVerifyFlow=(resource,context,binding)=>{
      const selected=this.admit(resource,context,'waitReady'),selectedContext={...context};
      return createAdapterFlowChart(binding,[{id:'guard-verify-target',name:'Verify pinned target and required references',phase:'revalidate',run:async()=>{await this.preflight();}}],
        options.delegate.createVerifyFlow!(selected,selectedContext,binding));
    };
  }

  /** Invoke in a recorded stage before change assessment; execution repeats it before provider calls. */
  async preflight(): Promise<KubernetesWorkloadPreflight> {
    const before = await this.options.guard.verify();
    const references = await this.options.probe.verify(this.references);
    const target = await this.options.guard.verify();
    if (before.targetDigest !== target.targetDigest || before.namespaceUidDigest !== target.namespaceUidDigest) throw new KubernetesWorkloadPreflightError('target-changed-during-preflight');
    return { graphDigest: this.graphDigest, target, references };
  }

  private admit(resource: Resource, context: ProviderContext, mode: 'observe' | 'apply' | 'remove' | 'waitReady'): Resource {
    if (context.stack !== this.stack || typeof context.operationId !== 'string' || !context.operationId) throw new KubernetesWorkloadPreflightError('workload-context-not-admitted');
    const detached = structuredClone(resource);
    const digest = resourceDigest(detached);
    const accepted = mode === 'remove' ? this.removals.has(digest)
      : mode === 'observe' ? this.desired.has(digest) || this.removals.has(digest) : this.desired.has(digest);
    if (!accepted) throw new KubernetesWorkloadPreflightError('workload-resource-not-admitted');
    return detached;
  }

  private async delegateObserve(resource: Resource, context: ProviderContext): Promise<Observation> {
    let observed: Observation;
    try { observed = await this.options.delegate.observe(resource, context); }
    catch { throw new KubernetesWorkloadAdapterError('provider-observe-failed'); }
    if (!observed || typeof observed.exists !== 'boolean'
      || (observed.owned !== undefined && typeof observed.owned !== 'boolean')
      || (observed.ready !== undefined && typeof observed.ready !== 'boolean')
      || (observed.fingerprint !== undefined && (typeof observed.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(observed.fingerprint)))) throw new KubernetesWorkloadAdapterError('provider-observation-invalid');
    // Return a narrow projection, never extra provider fields or a raw physicalId/error body.
    return { exists: observed.exists, physicalId: `kubernetes-pinned://${fingerprint({ scope: this.scope, resource: resource.id, metadata: resource.spec.metadata, kind: resource.spec.kind })}`,
      ...(observed.owned === undefined ? {} : { owned: observed.owned }), ...(observed.ready === undefined ? {} : { ready: observed.ready }),
      ...(observed.fingerprint === undefined ? {} : { fingerprint: observed.fingerprint }) };
  }

  async observe(resource: Resource, context: ProviderContext): Promise<Observation> {
    const selected = this.admit(resource, context, 'observe'), selectedContext = { ...context };
    await this.preflight();
    return this.delegateObserve(selected, selectedContext);
  }

  async apply(resource: Resource, context: ProviderContext): Promise<void> {
    const selected = this.admit(resource, context, 'apply'), selectedContext = { ...context };
    await this.preflight();
    const observed = await this.delegateObserve(selected, selectedContext);
    if (observed.exists && observed.owned !== true) throw new KubernetesWorkloadPreflightError('workload-unowned');
    // Retargeting or changed required references after ownership observation must stop before effects.
    await this.preflight();
    try { await this.options.delegate.apply(selected, selectedContext); }
    catch { throw new KubernetesWorkloadAdapterError('provider-apply-failed'); }
  }

  async remove(resource: Resource, context: ProviderContext): Promise<void> {
    const selected = this.admit(resource, context, 'remove'), selectedContext = { ...context };
    await this.preflight();
    const observed = await this.delegateObserve(selected, selectedContext);
    if (!observed.exists) return;
    if (observed.owned !== true) throw new KubernetesWorkloadPreflightError('workload-unowned');
    await this.preflight();
    try { await this.options.delegate.remove(selected, selectedContext); }
    catch { throw new KubernetesWorkloadAdapterError('provider-remove-failed'); }
  }

  async waitReady(resource: Resource, context: ProviderContext): Promise<void> {
    const selected = this.admit(resource, context, 'waitReady'), selectedContext = { ...context };
    await this.preflight();
    try { await this.options.delegate.waitReady(selected, selectedContext); }
    catch { throw new KubernetesWorkloadAdapterError('provider-wait-ready-failed'); }
  }
}

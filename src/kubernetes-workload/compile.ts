import type { JsonObject, Resource } from '../types.ts';
import type { CompiledKubernetesWorkload, KubernetesExternalReference, KubernetesWorkloadInput } from './types.ts';
import { asJson, key, list, name, object } from './validation.ts';
import { mergeKubernetesReferences } from './references.ts';
import { lowerKubernetesWorkloadGraph, lowerWorkloadVolume } from './lowering.ts';
import { assertWorkloadManifest } from './admission.ts';

/** Pure compilation, followed by the same strict admission used by guarded execution. */
export function compileKubernetesWorkload(input: KubernetesWorkloadInput): CompiledKubernetesWorkload {
  const graph = lowerKubernetesWorkloadGraph(input);
  return { graph, references: kubernetesWorkloadReferences(graph.resources, input.namespace, graph.name) };
}

/** Extract only external references; never read their values. Also admit the narrow managed resource set. */
export function kubernetesWorkloadReferences(resources: readonly Resource[], namespace: string, stack: string): KubernetesExternalReference[] {
  name(namespace, 'existing namespace');
  const references: KubernetesExternalReference[] = [];
  const add = (kind: KubernetesExternalReference['kind'], refName: unknown, keys: unknown[]) => references.push({ kind, namespace, name: name(refName), keys: keys.map(key) });
  for (const resource of resources) {
    assertWorkloadManifest(resource, namespace, stack);
    if (resource.spec.kind === 'Service') continue;
    const spec = asJson(resource.spec.spec);
    const pod = asJson(asJson(spec.template).spec);
    for (const value of list(pod.containers, 'containers')) {
      const container = asJson(value);
      if (container.env !== undefined) for (const value of list(container.env, 'environment entries', true)) {
        const entry = object(value, ['name', 'valueFrom'], 'environment entry');
        const from = object(entry.valueFrom, ['secretKeyRef', 'configMapKeyRef'], 'environment value source');
        const sources = ['secretKeyRef', 'configMapKeyRef'].filter(field => from[field] !== undefined);
        if (sources.length !== 1) throw new Error('Environment entries require an external key reference.');
        const ref = object(from[sources[0]!], ['name', 'key'], 'environment key reference');
        add(sources[0] === 'secretKeyRef' ? 'Secret' : 'ConfigMap', ref.name, [ref.key]);
      }
    }
    if (pod.imagePullSecrets !== undefined) for (const value of list(pod.imagePullSecrets, 'image pull secrets', true)) {
      const ref = object(value, ['name'], 'image pull secret');
      add('Secret', ref.name, ['.dockerconfigjson']);
    }
    if (pod.volumes !== undefined) for (const value of list(pod.volumes, 'volumes', true)) {
      const checked = lowerWorkloadVolume(value);
      if (checked.persistentVolumeClaim) add('PersistentVolumeClaim', asJson(checked.persistentVolumeClaim).claimName, []);
      for (const kind of ['secret', 'configMap'] as const) if (checked[kind]) {
        const ref = asJson(checked[kind]);
        add(kind === 'secret' ? 'Secret' : 'ConfigMap', ref[kind === 'secret' ? 'secretName' : 'name'], (ref.items as JsonObject[] ?? []).map(item => item.key));
      }
    }
  }
  return mergeKubernetesReferences(references, namespace);
}

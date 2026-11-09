import { keys, object } from '../graph/data.ts';
import type { JsonObject } from '../types.ts';
import { orderResources } from '../planner.ts';
import { artifactMapping, optionsRow, outputFile, outputFormat } from './artifact.ts';
import { resourceCollector } from './recorder.ts';
import type { OutputAdapter, OutputFormat } from './types.ts';

export function kubernetesOutput(options: { format?: OutputFormat } = {}): OutputAdapter {
  const row = optionsRow(options); keys(row, ['format'], 'Kubernetes output options');
  const format = outputFormat(row.format ?? 'json');
  const id = 'kubernetes-' + format;
  return {
    id,
    create(graph) {
      if (!graph.resources.length) throw new Error('Kubernetes output requires resources');
      for (const resource of graph.resources) {
        if (resource.provider !== 'kubernetes') throw new Error('Kubernetes output requires a Kubernetes binding');
        if (resource.lifecycle?.retainOnRemoval === true) throw new Error('Kubernetes manifests cannot express framework removal retention');
        const spec = resource.spec;
        const metadata = object(spec.metadata!, 'Kubernetes metadata');
        if (typeof spec.apiVersion !== 'string' || typeof spec.kind !== 'string' || typeof metadata.name !== 'string') throw new Error('Invalid Kubernetes object');
        if (spec.kind === 'List' || spec.status !== undefined) throw new Error('Kubernetes desired objects cannot be a List or contain status');
      }
      const identities = graph.resources.map(resource => {
        const metadata = resource.spec.metadata as JsonObject;
        return `${resource.spec.apiVersion}/${resource.spec.kind}/${metadata.namespace ?? ''}/${metadata.name}`;
      });
      if (new Set(identities).size !== identities.length) throw new Error('Duplicate native Kubernetes object identity');
      return resourceCollector(id, graph, resources => {
        const ordered = orderResources(resources);
        return {
          adapterId: id, format, graphDigest: graph.digest, validation: 'structural',
          files: [outputFile(`kubernetes.${format}`, { apiVersion: 'v1', kind: 'List', items: ordered.map(resource => resource.spec) }, format)],
          mappings: ordered.map((resource, index) => {
            const metadata = resource.spec.metadata as JsonObject;
            return artifactMapping(graph, resource.id, `${resource.spec.kind}/${metadata.namespace ?? ''}/${metadata.name}`, `/items/${index}`);
          }),
          limitations: ['Manifest files do not encode the direct engine readiness sequencing, retries or ownership inventory.',
            'Structural validation is local; API schema admission, authorization and live readiness require a separate deployment.'],
        };
      });
    },
  };
}

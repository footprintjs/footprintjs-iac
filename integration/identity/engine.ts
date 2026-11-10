import { join } from 'node:path';
import { InfraEngine, FileStateStore, KubernetesAdapter } from '../../src/index.ts';
import { createDeploymentRecorder } from '../../src/progress/index.ts';
import { IdentityFixtureAdapter } from './docker-adapter.ts';
import type { IdentityTarget } from './target.ts';

export function identityEngine(target: IdentityTarget) {
  const recorder = createDeploymentRecorder();
  const engine = new InfraEngine({
    adapters: [new IdentityFixtureAdapter(target.id), new KubernetesAdapter({ context: target.context, kubeconfig: target.kubeconfig, namespace: target.namespace })],
    store: new FileStateStore(target.stateDirectory), traceDirectory: join(target.directory, 'deployment-traces'), recorders: [recorder],
  });
  return { engine, recorder };
}

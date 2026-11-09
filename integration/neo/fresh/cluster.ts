import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { capture, run } from '../setup/command.ts';
import { REVIEW_NODE_IMAGE } from '../setup/target.ts';
import { assertFreshContainer, assertFreshKubeconfig, freshTargetPaths } from './target.ts';
import { NEO_NAMESPACE } from '../stack.ts';

/** This deliberately refuses reuse: an existing application cannot masquerade as a fresh deployment. */
export function createFreshCluster(target: ReturnType<typeof freshTargetPaths>): void {
  if (existsSync(target.directory) || capture('kind', ['get', 'clusters']).split(/\r?\n/).includes(target.clusterName)) {
    throw new Error('Recording target already exists; generate a new target instead of reusing it');
  }
  mkdirSync(target.directory, { recursive: true, mode: 0o700 });
  mkdirSync(target.stateDirectory, { mode: 0o700 });
  run('kind', ['create', 'cluster', '--name', target.clusterName, '--image', REVIEW_NODE_IMAGE,
    '--kubeconfig', target.kubeconfig, '--wait', '180s'], 240_000);
  assertFreshContainer(JSON.parse(capture('docker', ['inspect', '--format', '{{json .Config.Labels}}',
    `${target.clusterName}-control-plane`])), target.clusterName);
  writeFileSync(target.kubeconfig, capture('kind', ['get', 'kubeconfig', '--name', target.clusterName]) + '\n', { mode: 0o600 });
  chmodSync(target.kubeconfig, 0o600);
  const kubectl = ['--kubeconfig', target.kubeconfig, '--context', target.context];
  assertFreshKubeconfig(JSON.parse(capture('kubectl', [...kubectl, 'config', 'view', '--output=json'])), target.context);
  run('kubectl', [...kubectl, '--request-timeout=30s', 'wait', '--for=condition=Ready', 'node', '--all', '--timeout=180s'], 200_000);
  const namespace = capture('kubectl', [...kubectl, '--request-timeout=30s', 'get', 'namespace', NEO_NAMESPACE,
    '--ignore-not-found', '--output=json']);
  if (namespace || readdirSync(target.stateDirectory).length !== 0) throw new Error('A fresh target must have no Neo namespace or deployment state');
}

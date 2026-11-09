import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preflight, run } from './setup/command.ts';
import { NEO_NAMESPACE } from './stack.ts';
import { createFreshCluster } from './fresh/cluster.ts';
import { loadFreshImages } from './fresh/images.ts';
import { verifyFreshSource } from './fresh/source.ts';
import { freshTargetPaths } from './fresh/target.ts';
import type { FreshNeoTarget } from './fresh/target.ts';

/** Prepare credentials and images only. Lens/InfraEngine performs the application's first deployment later. */
export function prepareFreshNeo(sourceDirectory?: string) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  preflight();
  if (sourceDirectory !== undefined) {
    if (!sourceDirectory || sourceDirectory.startsWith('-')) throw new Error('Supply a clean Neo checkout path');
    run(process.execPath, [resolve(root, 'integration/neo/build.mjs'), resolve(sourceDirectory)]);
  }
  const source = verifyFreshSource(root);
  const target = freshTargetPaths(root, randomBytes(4).toString('hex'));
  console.log(`Preparing a new empty local cluster: ${target.clusterName}`);
  createFreshCluster(target);
  const images = loadFreshImages(target.clusterName, source.nodeImageId, source.pythonImageId);
  const descriptor: FreshNeoTarget & { sourceVerification: typeof source.verification; imageIds: { node: string; python: string } } = {
    version: 1, stage: 'prepared', clusterName: target.clusterName, context: target.context,
    kubeconfig: target.kubeconfig, stateDirectory: target.stateDirectory, namespace: NEO_NAMESPACE,
    sourceCommit: source.sourceCommit, images, preparedAt: new Date().toISOString(),
    sourceVerification: source.verification, imageIds: { node: source.nodeImageId, python: source.pythonImageId },
  };
  writeFileSync(resolve(target.directory, 'prepared.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
  const latestDirectory = resolve(root, '.artifacts/neo/fresh');
  mkdirSync(latestDirectory, { recursive: true, mode: 0o700 });
  const temporary = resolve(latestDirectory, `latest-${target.clusterName}.tmp`);
  writeFileSync(temporary, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, resolve(latestDirectory, 'latest.json'));
  console.log(JSON.stringify(descriptor, null, 2));
  console.log('Prepared only: the Neo namespace, Deployment and Service have not been created.');
  return descriptor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3) throw new Error('Usage: npm run neo:prepare-fresh -- [/path/to/clean/neo-agentfootprint]');
  prepareFreshNeo(process.argv[2]);
}

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { bindSystem } from '../src/binding/index.ts';
import { system } from '../src/system/index.ts';
import { createNeoSystem } from '../integration/neo/system.ts';
import { neoKubernetesProfile } from '../integration/neo/kubernetes-profile.ts';
import { awsObjectStorageProfile, cloudFormationOutput, kubernetesOutput, synthesize } from '../src/synthesis/index.ts';

const root = resolve('.artifacts/synthesis');
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, 'run-'));
const neo = bindSystem(createNeoSystem(), neoKubernetesProfile({ context: 'kind-footprint-iac-review' }));
const objectStorage = system('archive-example').addStorage('state', storage => storage.addStore('archive', store => store
  .dataModel('object').sharing('shared').durability('persistent').retainOnRemoval())).build();
const aws = bindSystem(objectStorage, awsObjectStorageProfile({ accountId: '123456789012', region: 'us-east-1' }));
for (const [name, graph, outputs] of [
  ['neo', neo.graph, [kubernetesOutput(), kubernetesOutput({ format: 'yaml' })]],
  ['aws-object-storage', aws.graph, [cloudFormationOutput(), cloudFormationOutput({ format: 'yaml' })]],
] as const) {
  const result = await synthesize(graph, { outputs });
  const target = join(directory, name); await mkdir(target, { mode: 0o700 });
  for (const artifact of result.artifacts) for (const file of artifact.files) await writeFile(join(target, file.path), file.content, { mode: 0o600 });
  await writeFile(join(target, 'recording.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(target, 'graph.json'), JSON.stringify(graph, null, 2) + '\n', { mode: 0o600 });
}
console.log(`PASS recorded native JSON/YAML synthesis; artifacts: ${directory}`);
console.log('Kubernetes uses the complete Neo desired graph. AWS is a narrow export-only S3 example with no provider calls.');

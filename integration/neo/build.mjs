import { execFileSync } from 'node:child_process';
import { prepareNeo } from './prepare.mjs';
import { checkPackagedMetadata } from './check-package.mjs';

if (!process.argv[2]) throw new Error('Usage: node integration/neo/build.mjs /path/to/neo-agentfootprint');
const snapshot = prepareNeo(process.argv[2]);
console.log(`Building local Neo fixture from ${snapshot.commit}`);
for (const [dockerfile, image] of [
  ['Node.Dockerfile', 'footprint-iac/neo-node:local'],
  ['Python.Dockerfile', 'footprint-iac/neo-python:local'],
]) {
  execFileSync('docker', ['build', '-f', `${snapshot.context}/.iac/${dockerfile}`, '-t', image, snapshot.context], { stdio: 'inherit' });
}
console.log(JSON.stringify(checkPackagedMetadata(), null, 2));
console.log('Both local images built. Load them into the explicitly chosen local Kubernetes cluster.');

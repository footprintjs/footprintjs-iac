import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const asset = '/app/node_modules/agentfootprint/canonical-notes.json';

/** A copied metadata asset must match the package the real Node host installed. */
export function verifyCanonicalMetadata(nodeBytes, pythonBytes) {
  assert.ok(nodeBytes.length > 0, 'The Node package must provide canonical metadata.');
  assert.ok(pythonBytes.length > 0, 'The Python sidecar must contain the published package metadata.');
  assert.ok(Buffer.from(nodeBytes).equals(Buffer.from(pythonBytes)), 'Python metadata differs from the actual Node package.');
  const metadata = JSON.parse(Buffer.from(nodeBytes).toString('utf8'));
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata));
  return { sha256: createHash('sha256').update(nodeBytes).digest('hex'), bytes: nodeBytes.length };
}

export function checkPackagedMetadata() {
  const nodeBytes = execFileSync('docker', [
    'run', '--rm', '--pull=never', '--entrypoint', 'node', 'footprint-iac/neo-node:local',
    '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(asset)}))`,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const pythonBytes = execFileSync('docker', [
    'run', '--rm', '--pull=never', '--entrypoint', 'python', 'footprint-iac/neo-python:local',
    '-c', `import pathlib,sys; sys.stdout.buffer.write(pathlib.Path(${JSON.stringify(asset)}).read_bytes())`,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return { passed: true, asset, ...verifyCanonicalMetadata(nodeBytes, pythonBytes) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node integration/neo/check-package.mjs');
  console.log(JSON.stringify(checkPackagedMetadata(), null, 2));
}

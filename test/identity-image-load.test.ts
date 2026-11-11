import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { identityNeoImageTag, loadIdentityNeoImages } from '../integration/identity/load-neo-images.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';

async function fixture(t: { after(callback: () => Promise<unknown> | void): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'identity-image-load-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.artifacts/identity'), id = 'a1b2c3d4';
  const target: IdentityTarget = { version: 1, id, directory: resolve(root, id), stateDirectory: resolve(root, id, 'state'),
    context: 'kind-footprint-iac-recording-b1b2c3d4', namespace: `footprint-iac-identity-${id}`,
    kubeconfig: resolve(root, '../..', '.artifacts/neo/fresh/b1b2c3d4/kubeconfig'), neoPort: 15230, providerPort: 15231, ldapPort: 15232,
    issuer: 'http://127.0.0.1:15231/realms/neo', providerName: `footprint-identity-${id}-provider`, directoryName: `footprint-identity-${id}-directory`,
    fixtureDigest: 'a'.repeat(64), images: { nodeImage: 'sha256:' + '1'.repeat(64), pythonImage: 'sha256:' + '2'.repeat(64),
      ldapImage: 'sha256:' + '3'.repeat(64), providerImage: 'sha256:' + '4'.repeat(64) } };
  const binaryDirectory = join(directory, 'bin'), log = join(directory, 'kind-calls.jsonl');
  await mkdir(binaryDirectory);
  await writeFile(join(binaryDirectory, 'kind'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o700 });
  const priorPath = process.env.PATH;
  process.env.PATH = binaryDirectory;
  t.after(() => { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; });
  return { target, root, log };
}

test('reviewed Neo images load through PATH kind into the exact re-admitted recording cluster', async t => {
  const f = await fixture(t), nodeId = 'sha256:' + '5'.repeat(64), pythonId = 'sha256:' + '6'.repeat(64);
  const admissions: (string | undefined)[] = [];
  const images = await loadIdentityNeoImages(f.target, nodeId, pythonId, { fixtureRoot: f.root,
    loadTarget: async path => { admissions.push(path); return structuredClone(f.target); } });
  assert.deepEqual(admissions, [join(f.target.directory, 'target.json')]);
  assert.deepEqual(images, { nodeImage: 'footprint-iac/neo-node:identity-' + '5'.repeat(64), pythonImage: 'footprint-iac/neo-python:identity-' + '6'.repeat(64) });
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [['load', 'docker-image', images.nodeImage, images.pythonImage, '--name', 'footprint-iac-recording-b1b2c3d4']]);
});

test('changed targets and malformed image IDs cannot invoke kind or select another cluster', async t => {
  const f = await fixture(t), nodeId = 'sha256:' + '5'.repeat(64), pythonId = 'sha256:' + '6'.repeat(64);
  await assert.rejects(loadIdentityNeoImages(f.target, nodeId, pythonId, { fixtureRoot: f.root,
    loadTarget: async () => ({ ...f.target, fixtureDigest: 'f'.repeat(64) }) }), /target changed/);
  let admitted = false;
  for (const id of ['latest', 'sha256:abc', 'sha256:' + 'G'.repeat(64), nodeId + ';other-command']) {
    await assert.rejects(loadIdentityNeoImages(f.target, id, pythonId, { fixtureRoot: f.root,
      loadTarget: async () => { admitted = true; return f.target; } }), /immutable Neo image ID/);
  }
  assert.equal(admitted, false);
  assert.throws(() => identityNeoImageTag('foreign' as 'node', nodeId), /immutable Neo image ID/);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildNeoImages } from '../integration/identity/build-neo-images.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'iac-stage-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.artifacts/identity'), id = 'a1b2c3d4', checkout = join(directory, 'source');
  await mkdir(checkout, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'seo-agentfootprint' }));
  await writeFile(join(checkout, 'release.txt'), 'new reviewed application source\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'source fixture');
  const tree = git('write-tree');
  const target: IdentityTarget = { version: 1, id, directory: resolve(root, id), stateDirectory: resolve(root, id, 'state'),
    context: 'kind-footprint-iac-recording-b1b2c3d4', namespace: `footprint-iac-identity-${id}`,
    kubeconfig: resolve(root, '../..', '.artifacts/neo/fresh/b1b2c3d4/kubeconfig'), neoPort: 15230, providerPort: 15231, ldapPort: 15232,
    issuer: 'http://127.0.0.1:15231/realms/neo', providerName: `footprint-identity-${id}-provider`, directoryName: `footprint-identity-${id}-directory`,
    fixtureDigest: 'a'.repeat(64), images: { nodeImage: 'sha256:' + '1'.repeat(64), pythonImage: 'sha256:' + '2'.repeat(64),
      ldapImage: 'sha256:' + '3'.repeat(64), providerImage: 'sha256:' + '4'.repeat(64) } };
  await mkdir(target.directory, { recursive: true });
  const targetPath = join(target.directory, 'target.json'), latest = join(root, 'latest.json');
  const original = JSON.stringify(target, null, 1) + '\n';
  await writeFile(targetPath, original); await writeFile(latest, original);
  const calls: { program: string; args: string[] }[] = [];
  const nodeId = 'sha256:' + '5'.repeat(64), pythonId = 'sha256:' + '6'.repeat(64);
  const runner = async (program: string, args: string[]) => {
    calls.push({ program, args: [...args] });
    if (program === 'tar') return execFileSync(program, args, { encoding: 'utf8' }).trim();
    if (program === 'docker' && args[0] === 'image') return args.at(-1)!.includes('python') ? pythonId : nodeId;
    if (!['docker', 'kind'].includes(program)) throw Error('Unexpected build command');
    return '';
  };
  return { target, targetPath, latest, original, tree, checkout, root, runner, calls, nodeId, pythonId };
}

test('stage-only builds load immutable images but leave the applied target and latest byte-identical', async t => {
  const f = await fixture(t);
  const result = await buildNeoImages(f.checkout, f.tree, f.targetPath, {
    stageOnly: true, fixtureRoot: f.root, runner: f.runner,
    loadTarget: async path => { assert.equal(path, f.targetPath); return structuredClone(f.target); },
  });
  assert.equal(await readFile(f.targetPath, 'utf8'), f.original);
  assert.equal(await readFile(f.latest, 'utf8'), f.original);
  assert.equal(result.stageOnly, true);
  assert.equal(result.targetPath, join(f.target.directory, 'candidates', f.tree, 'target.json'));
  const candidate = JSON.parse(await readFile(result.targetPath, 'utf8'));
  assert.equal(candidate.id, f.target.id); assert.equal(candidate.namespace, f.target.namespace);
  assert.equal(candidate.stateDirectory, f.target.stateDirectory);
  assert.equal(candidate.images.nodeImage, 'footprint-iac/neo-node:identity-' + '5'.repeat(64));
  assert.equal(candidate.images.pythonImage, 'footprint-iac/neo-python:identity-' + '6'.repeat(64));
  assert.equal(candidate.fixtureDigest, f.target.fixtureDigest);
  const review = JSON.parse(await readFile(join(result.targetPath, '../source-review.json'), 'utf8'));
  assert.equal(review.sourceTree, f.tree);
  assert.match(review.canonicalTargetSha256, /^[a-f0-9]{64}$/);
  assert.ok(f.calls.some(call => call.program === 'kind' && call.args.at(-1) === f.target.context.slice(5)));
  assert.ok(f.calls.some(call => call.program === 'docker' && call.args[0] === 'build'));
});

test('stage-only refuses an applied target changed during the build without replacing it', async t => {
  const f = await fixture(t), changed = f.original + '\n';
  await assert.rejects(buildNeoImages(f.checkout, f.tree, f.targetPath, {
    stageOnly: true, fixtureRoot: f.root, loadTarget: async () => structuredClone(f.target),
    runner: async (program, args, timeout) => {
      const output = await f.runner(program, args);
      if (program === 'kind') await writeFile(f.targetPath, changed);
      return output;
    },
  }), /applied target changed/);
  assert.equal(await readFile(f.targetPath, 'utf8'), changed);
  assert.equal(await readFile(f.latest, 'utf8'), f.original);
});

test('ordinary builds retain their existing explicit target-publication behavior', async t => {
  const f = await fixture(t);
  const result = await buildNeoImages(f.checkout, f.tree, f.targetPath, {
    fixtureRoot: f.root, runner: f.runner, loadTarget: async () => structuredClone(f.target),
  });
  assert.equal(result.stageOnly, false);
  assert.equal(result.targetPath, f.targetPath);
  const applied = JSON.parse(await readFile(f.targetPath, 'utf8'));
  assert.equal(applied.images.nodeImage, 'footprint-iac/neo-node:identity-' + '5'.repeat(64));
  assert.deepEqual(JSON.parse(await readFile(f.latest, 'utf8')), applied);
});

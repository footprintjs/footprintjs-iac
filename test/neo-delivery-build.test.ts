import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { neoDeliveryBuildAdapters, neoDeliveryRecipe } from '../integration/identity/github-delivery/build.ts';
import { neoCandidateDeliveryRevision, readNeoDeliveryCandidate, neoDeliveryTarget } from '../integration/identity/github-delivery/target.ts';
import { publishNeoDeliveryTarget } from '../integration/identity/github-delivery/publication.ts';
import type { IdentityTarget } from '../integration/identity/target.ts';
import type { DeliveryContext } from '../src/delivery/types.ts';
import type { MasterState, SystemRevision } from '../src/master/types.ts';
import type { MasterWorkflow } from '../src/master/workflow.ts';
import { neoDeliveryDeploymentAdapter } from '../integration/identity/github-delivery/deployment.ts';
import { buildNeoImages } from '../integration/identity/build-neo-images.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'iac-neo-delivery-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.artifacts/identity'), id = 'a1b2c3d4', checkout = join(directory, 'source');
  await mkdir(checkout, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'seo-agentfootprint' }));
  await writeFile(join(checkout, 'release.txt'), 'pinned source\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'source fixture');
  const tree = git('write-tree'), commit = git('rev-parse', 'HEAD');
  const target: IdentityTarget = { version: 1, id, directory: resolve(root, id), stateDirectory: resolve(root, id, 'state'),
    context: 'kind-footprint-iac-recording-b1b2c3d4', namespace: `footprint-iac-identity-${id}`,
    kubeconfig: resolve(root, '../..', '.artifacts/neo/fresh/b1b2c3d4/kubeconfig'), neoPort: 15230, providerPort: 15231, ldapPort: 15232,
    issuer: 'http://127.0.0.1:15231/realms/neo', providerName: `footprint-identity-${id}-provider`, directoryName: `footprint-identity-${id}-directory`,
    fixtureDigest: 'a'.repeat(64), images: { nodeImage: 'sha256:' + '1'.repeat(64), pythonImage: 'sha256:' + '2'.repeat(64),
      ldapImage: 'sha256:' + '3'.repeat(64), providerImage: 'sha256:' + '4'.repeat(64) } };
  await mkdir(target.directory, { recursive: true });
  const targetPath = join(target.directory, 'target.json'), original = JSON.stringify(target, null, 1) + '\n';
  await writeFile(targetPath, original); await writeFile(join(root, 'latest.json'), original);
  const calls: { program: string; args: string[] }[] = [];
  const runner = async (program: string, args: string[]) => {
    calls.push({ program, args: [...args] });
    if (program === 'tar') return execFileSync(program, args, { encoding: 'utf8' }).trim();
    if (program === 'docker' && args[0] === 'image') return 'sha256:' + (args.at(-1)!.includes('python') ? '6' : '5').repeat(64);
    if (!['docker', 'kind'].includes(program)) throw Error('Unexpected command');
    return '';
  };
  const repository = 'https://github.com/example/neo', ref = 'main';
  const context: DeliveryContext = { executionId: 'test-execution', operationId: 'test-operation', definitionDigest: '9'.repeat(64), target: neoDeliveryTarget(target) };
  const adapters = neoDeliveryBuildAdapters({ targetPath, source: { repository, ref }, sourceAdapter: {} as never,
    buildOptions: { fixtureRoot: root, runner, loadTarget: async () => structuredClone(target) } }, target, await neoDeliveryRecipe());
  return { target, targetPath, original, tree, commit, checkout, root, calls, git, repository, ref, context, adapters };
}

test('Neo delivery builds the pinned checkout separately from publishing its immutable images', async t => {
  const f = await fixture(t), recipe = await neoDeliveryRecipe();
  const result = await f.adapters.build.build({ location: f.checkout, revision: {
    repository: f.repository, ref: f.ref, commit: f.commit, tree: f.tree,
  } }, recipe, f.context);
  assert.equal(f.calls.some(call => call.program === 'kind'), false, 'build must not secretly publish to the cluster');
  assert.equal(await readFile(f.targetPath, 'utf8'), f.original, 'a successful build cannot change applied bindings');
  // Generic receipt admission rebuilds objects in contract order; JSON member order is not identity.
  const admitted = { ...result, artifacts: result.artifacts.map(({ id, digest, reference }) => ({ id, digest, reference })) };
  const publication = await f.adapters.artifacts.publish(admitted, f.context);
  assert.deepEqual(publication.artifacts, result.artifacts);
  assert.equal(f.calls.filter(call => call.program === 'kind').length, 1);
  assert.equal(await readFile(f.targetPath, 'utf8'), f.original, 'publishing a cache entry cannot promote a release');
  assert.deepEqual(publication.artifacts.map(item => item.id), ['node', 'python']);
});

test('Neo delivery refuses a changed checkout or forged image identity before publishing', async t => {
  const f = await fixture(t), recipe = await neoDeliveryRecipe(), source = { location: f.checkout,
    revision: { repository: f.repository, ref: f.ref, commit: f.commit, tree: f.tree } };
  await writeFile(join(f.checkout, 'release.txt'), 'unreviewed change\n');
  await assert.rejects(f.adapters.build.build(source, recipe, f.context), /pinned GitHub commit/);
  assert.equal(f.calls.length, 0);
  f.git('checkout', '--', 'release.txt');
  const built = await f.adapters.build.build(source, recipe, f.context);
  built.artifacts[0]!.digest = '7'.repeat(64);
  await assert.rejects(f.adapters.artifacts.publish(built, f.context), /identities differ/);
  assert.equal(f.calls.filter(call => call.program === 'kind').length, 0);
});

test('Neo candidate admission binds target ownership and refuses publication without a proven master promotion', async t => {
  const f = await fixture(t), built = await f.adapters.build.build({ location: f.checkout,
    revision: { repository: f.repository, ref: f.ref, commit: f.commit, tree: f.tree } }, await neoDeliveryRecipe(), f.context);
  const path = String(built.metadata!.candidatePath), candidate = await readNeoDeliveryCandidate(path, f.target);
  await assert.rejects(readNeoDeliveryCandidate(path.replace('target.json', 'other.json'), f.target), /staged/);
  const revision = { digest: '8'.repeat(64) } as SystemRevision;
  await assert.rejects(publishNeoDeliveryTarget({ current: f.target, candidate, revision,
    master: { appliedDigest: '9'.repeat(64), attempts: [] } as unknown as MasterState,
    canonicalBytes: f.original, directory: join(f.target.directory, 'master') }), /proven applied/);
  assert.equal(await readFile(f.targetPath, 'utf8'), f.original);
});

test('new immutable deliveries can reuse a source tree while preserving commit and artifact revision identity', async t => {
  const f = await fixture(t), recipe = await neoDeliveryRecipe();
  const first = await f.adapters.build.build({ location: f.checkout,
    revision: { repository: f.repository, ref: f.ref, commit: f.commit, tree: f.tree } }, recipe, f.context);
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'new commit same tree');
  const secondCommit = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('write-tree'), f.tree);
  const secondContext = { ...f.context, executionId: 'another-delivery' };
  const secondSource = { location: f.checkout,
    revision: { repository: f.repository, ref: f.ref, commit: secondCommit, tree: f.tree } };
  const second = await f.adapters.build.build(secondSource, recipe, secondContext);
  assert.notEqual(first.metadata!.candidatePath, second.metadata!.candidatePath);
  const a = await readNeoDeliveryCandidate(String(first.metadata!.candidatePath), f.target);
  const b = await readNeoDeliveryCandidate(String(second.metadata!.candidatePath), f.target);
  const revisionA = neoCandidateDeliveryRevision(a, f.repository, '9'.repeat(64));
  const revisionB = neoCandidateDeliveryRevision(b, f.repository, '9'.repeat(64));
  assert.equal(revisionA.graph.digest, revisionB.graph.digest, 'identical program artifacts do not manufacture infrastructure changes');
  assert.notEqual(revisionA.revisionId, revisionB.revisionId, 'source commit identity remains distinct');
  const changed = structuredClone(b);
  changed.target.images.nodeImage = 'footprint-iac/neo-node:identity-' + '7'.repeat(64);
  const rebuilt = neoCandidateDeliveryRevision(changed, f.repository, '9'.repeat(64));
  assert.notEqual(rebuilt.revisionId, revisionB.revisionId, 'a changed build artifact is a distinct revision even for the same source tree');
  await assert.rejects(f.adapters.build.build(secondSource, recipe, secondContext), /already has a staged candidate/,
    'an existing execution-scoped candidate is immutable');
});

test('a self-consistent candidate substituted after plan cannot apply or publish different artifacts', async t => {
  const f = await fixture(t), built = await f.adapters.build.build({ location: f.checkout,
    revision: { repository: f.repository, ref: f.ref, commit: f.commit, tree: f.tree } }, await neoDeliveryRecipe(), f.context);
  const candidate = await readNeoDeliveryCandidate(String(built.metadata!.candidatePath), f.target);
  const revision = neoCandidateDeliveryRevision(candidate, f.repository, '9'.repeat(64)), directory = join(f.target.directory, 'deliveries/test');
  const receiptPath = join(directory, 'plans/review-test.json');
  const plan = { id: 'review-test', digest: '8'.repeat(64), changes: [{ resourceId: 'neo-app', action: 'update' as const }], metadata: { receiptPath } };
  await mkdir(join(directory, 'plans'), { recursive: true });
  await writeFile(receiptPath, JSON.stringify({ plan, revision, candidatePath: candidate.path, canonicalBytes: f.original }));
  const altered = structuredClone(candidate.target), alteredReceipt = structuredClone(candidate.receipt);
  altered.images.nodeImage = alteredReceipt.image = 'footprint-iac/neo-node:identity-' + '7'.repeat(64);
  alteredReceipt.imageId = 'sha256:' + '7'.repeat(64);
  await writeFile(candidate.path, JSON.stringify(altered));
  await writeFile(join(candidate.path, '../source-review.json'), JSON.stringify(alteredReceipt));
  await readNeoDeliveryCandidate(candidate.path, f.target); // It is internally consistent, but not the reviewed release.
  let applies = 0;
  const master = { async getState() { return { review: { reviewId: plan.id, planDigest: plan.digest }, candidateDigest: revision.digest }; },
    async apply() { applies++; throw Error('Must not apply'); } } as unknown as MasterWorkflow;
  const adapter = neoDeliveryDeploymentAdapter({ targetPath: f.targetPath, source: { repository: f.repository, ref: f.ref }, sourceAdapter: {} as never },
    f.target, directory, master, () => {});
  await assert.rejects(adapter.deploy(plan, f.context), /sealed source/);
  assert.equal(applies, 0); assert.equal(await readFile(f.targetPath, 'utf8'), f.original);
  await assert.rejects(publishNeoDeliveryTarget({ current: f.target, candidate, revision,
    master: { appliedDigest: revision.digest, attempts: [{ status: 'applied', revisionDigest: revision.digest }] } as unknown as MasterState,
    canonicalBytes: f.original, directory: join(f.target.directory, 'master') }), /sealed source/);
  assert.equal(await readFile(f.targetPath, 'utf8'), f.original);
});

test('interleaved delivery builds isolate temporary tags, contexts and archives for the same target', async t => {
  const f = await fixture(t), second = join(f.checkout, '../second');
  execFileSync('git', ['clone', '--quiet', f.checkout, second]);
  await writeFile(join(second, 'release.txt'), 'second independent source tree\n');
  execFileSync('git', ['-C', second, 'add', '.']);
  execFileSync('git', ['-C', second, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'second source']);
  const secondTree = execFileSync('git', ['-C', second, 'write-tree'], { encoding: 'utf8' }).trim();
  const images = new Map<string, string>(), tags: string[] = [], contexts: string[] = [];
  let nodeBuilds = 0, releaseFirst!: () => void;
  const firstMustWait = new Promise<void>(resolve => { releaseFirst = resolve; });
  const runner = async (program: string, args: string[]) => {
    if (program === 'tar') return execFileSync(program, args, { encoding: 'utf8' }).trim();
    assert.equal(program, 'docker');
    if (args[0] === 'build') {
      const isNode = args.some(arg => arg.endsWith('/Node.Dockerfile')), context = args.at(-1)!;
      const isFirst = context.endsWith(f.tree), tag = args[args.indexOf('-t') + 1]!;
      const identity = 'sha256:' + (isNode ? isFirst ? '5' : '7' : isFirst ? '6' : '8').repeat(64);
      images.set(tag, identity);
      if (isNode) {
        tags.push(tag); contexts.push(context); nodeBuilds++;
        if (nodeBuilds === 1) await firstMustWait; else releaseFirst();
      }
      return '';
    }
    if (args[0] === 'image' && args[1] === 'inspect') return images.get(args.at(-1)!)!;
    if (args[0] === 'tag') { images.set(args[2]!, args[1]!); return ''; }
    throw Error('Unexpected build command');
  };
  const common = { stageOnly: true, deferImageLoad: true, fixtureRoot: f.root, runner, loadTarget: async () => structuredClone(f.target) };
  const [a, b] = await Promise.all([
    buildNeoImages(f.checkout, f.tree, f.targetPath, { ...common, candidateScope: 'first-delivery' }),
    buildNeoImages(second, secondTree, f.targetPath, { ...common, candidateScope: 'second-delivery' }),
  ]);
  assert.equal(new Set(tags).size, 2); assert.equal(new Set(contexts).size, 2);
  assert.equal(a.imageId, 'sha256:' + '5'.repeat(64)); assert.equal(b.imageId, 'sha256:' + '7'.repeat(64));
  assert.equal(a.pythonImageId, 'sha256:' + '6'.repeat(64)); assert.equal(b.pythonImageId, 'sha256:' + '8'.repeat(64));
  assert.notEqual(a.targetPath, b.targetPath); assert.equal(await readFile(f.targetPath, 'utf8'), f.original);
});

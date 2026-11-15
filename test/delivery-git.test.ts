import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSourceAdapter, createGitHubSourceAdapter, githubRepository } from '../src/delivery-git/index.ts';
import type { DeliveryContext } from '../src/delivery/types.ts';

const context = (executionId = 'delivery-a'): DeliveryContext => ({ executionId, operationId: 'stage-a',
  definitionDigest: 'a'.repeat(64), target: { id: 'test', scope: 'local' } });
function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Delivery test',
    '-c', 'user.email=delivery@example.invalid', '-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'iac-git-source-')), repository = join(root, 'source with spaces');
  execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'ignore' });
  await writeFile(join(repository, 'app.txt'), 'version one\n');
  await writeFile(join(repository, '.gitignore'), 'ignored.txt\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Version one');
  return { root, repository, commit: git(repository, 'rev-parse', 'HEAD'), tree: git(repository, 'rev-parse', 'HEAD^{tree}') };
}

test('Git source pins real objects before a branch moves and materializes a detached verified checkout', async () => {
  const f = await fixture();
  try {
    const adapter = new GitSourceAdapter({ directory: join(f.root, 'sources'), repository: f.repository,
      allowedRefs: ['main'], allowLocalRepository: true });
    const source = { repository: f.repository, ref: 'main' };
    const revision = await adapter.resolve(source, context());
    assert.equal(revision.commit, f.commit); assert.equal(revision.tree, f.tree);
    await writeFile(join(f.repository, 'app.txt'), 'version two\n');
    git(f.repository, 'commit', '-am', 'Version two');
    const snapshot = await adapter.fetch(revision, { ...context(), operationId: 'fetch-stage' });
    assert.equal(await readFile(join(snapshot.location, 'app.txt'), 'utf8'), 'version one\n');
    assert.equal(git(snapshot.location, 'rev-parse', 'HEAD'), f.commit);
    assert.throws(() => git(snapshot.location, 'symbolic-ref', '-q', 'HEAD'), 'HEAD must be detached');
    assert.deepEqual(await adapter.resolve(source, context()), revision, 'one execution stays pinned');
    assert.deepEqual(await adapter.fetch(revision, context()), snapshot);
    const next = await adapter.resolve(source, context('delivery-b'));
    assert.notEqual(next.commit, revision.commit, 'a new execution may resolve a new version');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Git source refuses changed checkouts, substituted commits/trees and a different target', async () => {
  const f = await fixture();
  try {
    const adapter = new GitSourceAdapter({ directory: join(f.root, 'sources'), repository: f.repository,
      allowedRefs: ['main'], allowLocalRepository: true });
    const revision = await adapter.resolve({ repository: f.repository, ref: 'main' }, context());
    await assert.rejects(adapter.fetch({ ...revision, tree: 'b'.repeat(40) }, context()), /exact Git revision/);
    await assert.rejects(adapter.fetch(revision, { ...context(), target: { id: 'other', scope: 'local' } }), /Resolve this exact/);
    const snapshot = await adapter.fetch(revision, context());
    await writeFile(join(snapshot.location, 'app.txt'), 'unreviewed local edit');
    await assert.rejects(adapter.fetch(revision, context()), /snapshot was changed/);
    assert.equal(await readFile(join(snapshot.location, 'app.txt'), 'utf8'), 'unreviewed local edit', 'rejection never overwrites files');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('GitHub source accepts only the configured repository/ref and rejects credential-bearing URLs before I/O', async () => {
  assert.equal(githubRepository('footprintjs/example'), 'https://github.com/footprintjs/example.git');
  assert.equal(githubRepository('https://github.com/footprintjs/example'), 'https://github.com/footprintjs/example.git');
  for (const repository of ['https://user:private-token@github.com/org/repo', 'https://github.com/org/repo?token=x',
    'https://elsewhere.invalid/org/repo', 'file:///tmp/repo']) assert.throws(() => githubRepository(repository));
  let commands = 0;
  const adapter = createGitHubSourceAdapter({ directory: '/tmp/unused-iac-source-test', repository: 'footprintjs/example', allowedRefs: ['main'],
    runner: async () => { commands++; throw Error('private-token'); } });
  await assert.rejects(adapter.resolve({ repository: 'https://github.com/other/repo.git', ref: 'main' }, context()), /configured/);
  for (const ref of ['--upload-pack=bad', 'main..other', 'main\nother', 'refs/heads/../../bad', 'unapproved'])
    await assert.rejects(adapter.resolve({ repository: adapter.repository, ref }, context()));
  assert.equal(commands, 0);
});

test('Git snapshot reuse rejects ignored files and index flags that hide changed working bytes', async () => {
  const f = await fixture();
  try {
    const adapter = new GitSourceAdapter({ directory: join(f.root, 'sources'), repository: f.repository,
      allowedRefs: ['main'], allowLocalRepository: true });
    const revision = await adapter.resolve({ repository: f.repository, ref: 'main' }, context());
    const snapshot = await adapter.fetch(revision, context());
    await writeFile(join(snapshot.location, 'ignored.txt'), 'unrecorded build input');
    await assert.rejects(adapter.fetch(revision, context()), /snapshot was changed/);
    await rm(join(snapshot.location, 'ignored.txt'));
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      git(snapshot.location, 'update-index', '--' + flag, 'app.txt');
      await writeFile(join(snapshot.location, 'app.txt'), 'hidden changed bytes');
      await assert.rejects(adapter.fetch(revision, context()), /snapshot was changed/);
      git(snapshot.location, 'update-index', '--no-' + flag, 'app.txt');
      git(snapshot.location, 'checkout', '--', 'app.txt');
    }
    assert.deepEqual(await adapter.fetch(revision, context()), snapshot);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

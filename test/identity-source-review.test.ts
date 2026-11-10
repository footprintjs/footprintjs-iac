import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSourceReview } from '../integration/identity/source-review.ts';

async function sourceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'iac-source-review-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(directory, 'app.txt'), 'committed source\n');
  git('add', 'app.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'source fixture');
  const baseCommit = git('rev-parse', 'HEAD');
  const committedTree = git('rev-parse', baseCommit + '^{tree}');
  return { directory, git, baseCommit, committedTree };
}

test('a reviewed index matching the exact committed tree is labelled committed-clean', async () => {
  const fixture = await sourceFixture();
  try {
    const sourceTree = fixture.git('write-tree');
    const review = describeSourceReview({ baseCommit: fixture.baseCommit, committedTree: fixture.committedTree, sourceTree });
    assert.equal(review.sourceStatus, 'committed-clean');
    assert.equal(review.baseCommit, fixture.baseCommit);
    assert.equal(review.sourceTree, sourceTree);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('a staged source snapshot retains its committed base without claiming to be committed', async () => {
  const fixture = await sourceFixture();
  try {
    await writeFile(join(fixture.directory, 'app.txt'), 'reviewed staged source\n');
    fixture.git('add', 'app.txt');
    const sourceTree = fixture.git('write-tree');
    assert.notEqual(sourceTree, fixture.committedTree);
    const review = describeSourceReview({ baseCommit: fixture.baseCommit, committedTree: fixture.committedTree, sourceTree });
    assert.equal(review.sourceStatus, 'reviewed-uncommitted-index');
    assert.equal(review.baseCommit, fixture.baseCommit);
    assert.equal(review.sourceTree, sourceTree);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('source and image-build metadata do not claim application-check or publication results', () => {
  const revision = { baseCommit: 'a'.repeat(40), committedTree: 'b'.repeat(40), sourceTree: 'b'.repeat(40) };
  const review = describeSourceReview(revision) as Record<string, unknown>;
  assert.equal(review.fullAppCheckStatus, 'not-assessed-by-build');
  assert.equal(review.publicationStatus, 'not-assessed-by-build');
  assert.doesNotMatch(JSON.stringify(review), /passed focused checks|full-suite failures|not a published Neo commit/);
});

test('malformed source revisions are refused rather than labelled', () => {
  const revision = { baseCommit: 'a'.repeat(40), committedTree: 'b'.repeat(40), sourceTree: 'b'.repeat(40) };
  for (const key of ['baseCommit', 'committedTree', 'sourceTree'] as const) {
    assert.throws(() => describeSourceReview({ ...revision, [key]: 'HEAD' }), /exact Git revisions/);
  }
});

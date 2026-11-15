import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createPinnedHostPreparationAction } from '../src/platform-bootstrap/preparation-actions.ts';

async function shell(script: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: process.env.PATH } });
    child.on('error', reject); child.on('close', resolve); child.stdin.end(script);
  });
}

test('a preparation action checks copied artifact bytes before executing and cleans its private copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-recipe-'));
  try {
    const recipe = join(directory, "reviewed ' recipe.sh"), output = join(directory, 'effect');
    const bytes = `#!/bin/sh\nprintf 'prepared' > '${output}'\n`;
    await writeFile(recipe, bytes, { mode: 0o600 });
    const action = createPinnedHostPreparationAction({ id: 'prepare-node', recipePath: recipe,
      recipeSha256: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(action.effect, 'mutating');
    assert.equal(await shell(action.script), 0);
    assert.equal(await readFile(output, 'utf8'), 'prepared');
    await rm(output);
    await writeFile(recipe, bytes + '\necho changed\n');
    assert.notEqual(await shell(action.script), 0);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    assert.deepEqual((await readdir(directory)).sort(), ["reviewed ' recipe.sh"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recipe registration rejects unpinned or unsafe artifacts without reflecting supplied values', () => {
  const marker = 'private-provider-marker';
  for (const input of [
    { id: 'prepare', recipePath: 'relative.sh', recipeSha256: 'a'.repeat(64) },
    { id: 'prepare', recipePath: '/tmp/file.sh', recipeSha256: marker },
    { id: 'prepare', recipePath: '/tmp/../file.sh', recipeSha256: 'a'.repeat(64) },
    { id: 'prepare', recipePath: '/tmp/file.sh', recipeSha256: 'a'.repeat(64), interpreterPath: 'sh' },
  ]) assert.throws(() => createPinnedHostPreparationAction(input), error => error instanceof Error && !error.message.includes(marker));
});

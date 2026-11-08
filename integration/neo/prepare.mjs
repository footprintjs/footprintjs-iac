import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultArtifacts = resolve(here, '../../.artifacts/neo');

/** Snapshot committed source only; never copy the checkout's .env or node_modules. */
export function prepareNeo(sourceDirectory, options = {}) {
  const source = resolve(sourceDirectory);
  const artifacts = resolve(options.artifactsDirectory ?? defaultArtifacts);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  const trackedChanges = git('status', '--porcelain', '--untracked-files=no');
  if (trackedChanges) throw new Error('Neo has tracked edits. Commit or choose a clean checkout so the trial source is unambiguous.');
  const packageJson = JSON.parse(git('show', 'HEAD:package.json'));
  if (packageJson.name !== 'seo-agentfootprint') throw new Error('Expected the neo-agentfootprint application checkout.');
  const names = git('ls-tree', '-r', '--name-only', commit).split('\n');
  // A tracked credential file is not made safe by git archive. Refuse it
  // before writing a snapshot; known example templates remain admissible.
  const privateFile = names.find(name => {
    const leaf = name.split('/').at(-1);
    return leaf !== '.env.example' && (
      leaf === '.env' || leaf === '.npmrc' || /\.env$|\.(pem|key)$/.test(leaf ?? '')
      || (leaf?.startsWith('.env.') && leaf !== '.env.example')
      || /(^|\/)\.claude\/settings\.json$/.test(name)
    );
  });
  if (privateFile) throw new Error('Tracked credential/config material is refused in the trial build context.');
  mkdirSync(artifacts, { recursive: true });
  const context = mkdtempSync(resolve(artifacts, 'context-'));
  const archive = resolve(artifacts, `source-${commit}.tar`);
  execFileSync('git', ['-C', source, 'archive', '--format=tar', `--output=${archive}`, commit]);
  execFileSync('tar', ['-xf', archive, '-C', context]);
  mkdirSync(resolve(context, '.iac'));
  for (const file of ['Node.Dockerfile', 'Python.Dockerfile', 'start-sidecar.py']) {
    copyFileSync(resolve(here, file), resolve(context, '.iac', file));
  }
  writeFileSync(resolve(context, '.dockerignore'), [
    '.git', '**/.git', 'node_modules', '**/node_modules', '.env', '**/.env',
    '.env.*', '**/.env.*', '*.env', '**/*.env', '.npmrc', '**/.npmrc',
    '*.pem', '**/*.pem', '*.key', '**/*.key', '.dev', '.local', '.artifacts',
    '**/.artifacts', '.claude', '.codex', '**/.venv', '**/__pycache__',
  ].join('\n') + '\n');
  const metadata = { source, commit, context, sourceName: packageJson.name, mode: 'local-sqlite-fixture', createdAt: new Date().toISOString() };
  writeFileSync(resolve(artifacts, 'source.json'), JSON.stringify(metadata, null, 2) + '\n');
  writeFileSync(resolve(artifacts, 'build-context.txt'), context + '\n');
  // Ensure packaging is present before returning a usable context.
  readFileSync(resolve(context, '.iac/Node.Dockerfile'));
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node integration/neo/prepare.mjs /path/to/neo-agentfootprint');
  console.log(JSON.stringify(prepareNeo(process.argv[2]), null, 2));
}

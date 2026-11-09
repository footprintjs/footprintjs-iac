import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { capture } from '../setup/command.ts';

interface SourceRecord { source: string; context: string; commit: string }
interface SourceFile { path: string; sha256: string }

/** NUL-delimited Git records preserve spaces and Unicode without C-style filename quoting. */
export function parseNeoSourceTree(tree: string): { path: string; blobId: string }[] {
  return tree.split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(line);
    const path = match?.[3];
    if (!match || !path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) {
      throw new Error('Expected regular committed application files in the Neo source manifest');
    }
    return { path, blobId: match[2]! };
  });
}

/** Compare application source in cached images with the recorded committed build snapshot. */
export function verifyFreshSource(root: string) {
  const record = JSON.parse(readFileSync(resolve(root, '.artifacts/neo/source.json'), 'utf8')) as SourceRecord;
  if (!/^[a-f0-9]{40}$/.test(record.commit) || typeof record.source !== 'string' || typeof record.context !== 'string') {
    throw new Error('Build committed Neo images with npm run neo:setup before preparing a fresh target');
  }
  const artifacts = realpathSync(resolve(root, '.artifacts/neo'));
  const context = realpathSync(record.context);
  if (!context.startsWith(artifacts + sep)) throw new Error('Neo build snapshot must be inside this library artifact directory');
  if (capture('git', ['-C', record.source, 'rev-parse', 'HEAD']) !== record.commit
    || capture('git', ['-C', record.source, 'status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Neo source checkout must still match its clean recorded commit; supply a clean checkout to rebuild');
  }
  const tree = capture('git', ['-C', record.source, 'ls-tree', '-rz', record.commit, '--',
    'src', 'be-server', 'packages', 'py-tools', 'package.json', 'package-lock.json']);
  const files: SourceFile[] = parseNeoSourceTree(tree).map(({ path, blobId }) => {
    const bytes = readFileSync(resolve(context, path));
    const actualBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actualBlob !== blobId) throw new Error(`Prepared Neo source differs from its Git commit: ${path}`);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  if (!files.some(file => file.path === 'be-server/server.ts') || !files.some(file => file.path.startsWith('py-tools/'))) {
    throw new Error('Expected the real Neo application and Python sidecar source');
  }
  const nodeImageId = capture('docker', ['image', 'inspect', '--format', '{{.Id}}', 'footprint-iac/neo-node:local']);
  const pythonImageId = capture('docker', ['image', 'inspect', '--format', '{{.Id}}', 'footprint-iac/neo-python:local']);
  const manifest = JSON.stringify(files);
  // No network, host mount, writable container filesystem or application entrypoint is needed for source verification.
  execFileSync('docker', ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '-i',
    '--entrypoint', 'node', nodeImageId, '-e',
    `const fs=require('node:fs'),crypto=require('node:crypto');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{for(const f of JSON.parse(input)){const hash=crypto.createHash('sha256').update(fs.readFileSync('/app/'+f.path)).digest('hex');if(hash!==f.sha256)throw Error('Neo image source mismatch: '+f.path)}});`],
  { input: manifest, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const pythonFiles = files.filter(file => file.path.startsWith('py-tools/'));
  execFileSync('docker', ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '-i',
    '--entrypoint', 'python', pythonImageId, '-c',
    "import hashlib,json,pathlib,sys\nfor f in json.load(sys.stdin):\n if hashlib.sha256(pathlib.Path('/app/'+f['path']).read_bytes()).hexdigest()!=f['sha256']: raise ValueError('Neo image source mismatch: '+f['path'])"],
  { input: JSON.stringify(pythonFiles), timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return { sourceCommit: record.commit, nodeImageId, pythonImageId,
    verification: { nodeSourceFiles: files.length, pythonSourceFiles: pythonFiles.length,
      manifestSha256: createHash('sha256').update(manifest).digest('hex') } };
}

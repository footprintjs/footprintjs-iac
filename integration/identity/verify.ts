import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { checkIdentityAccess } from '../../src/identity/index.ts';
import { loadEvidence, replay, backwalk } from '../../src/evidence.ts';
import { loadIdentityTarget } from './target.ts';
import { neoIdentityChecks, neoIdentityCheckAdapter } from './checks.ts';

const target = await loadIdentityTarget(process.argv[2]);
const result = await checkIdentityAccess({ stack: `neo-identity-${target.id}`, checks: neoIdentityChecks,
  adapter: await neoIdentityCheckAdapter(target), traceDirectory: join(target.directory, 'identity-traces') });
await mkdir(join(target.directory, 'identity'), { recursive: true, mode: 0o700 });
const path = join(target.directory, 'identity', result.runId + '.json');
await writeFile(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const evidence = await loadEvidence(path);
assert.deepEqual(replay(evidence).state, evidence.snapshot.sharedState, 'Identity replay must reproduce its recorded state');
for (const check of neoIdentityChecks) await writeFile(join(target.directory, 'identity', result.runId + '-' + check.id + '.backwalk.txt'), backwalk(evidence, `progress:${check.id}`).text + '\n', { mode: 0o600 });
console.log(JSON.stringify({ ok: result.ok, runId: result.runId, evidencePath: path,
  checks: Object.values(result.checks).map(check => ({ id: check.checkId, status: check.status, expected: check.expected, observed: check.observation.verdict, details: check.observation.details })) }, null, 2));
if (!result.ok) process.exitCode = 1;

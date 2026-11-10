import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { backwalk, loadEvidence, replay } from '../../src/index.ts';
import { fingerprint } from '../../src/util.ts';
import { command } from './command.ts';
import { identityRoot, loadIdentityTarget, validateIdentityTarget, type IdentityTarget } from './target.ts';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const recordName = new RegExp('^' + UUID + '\\.json$');
const traceName = new RegExp('^traces/' + UUID + '\\.jsonl$');
const lensEvidenceRoots = ['lens', 'lens-live-app'] as const;
const podScript = String.raw`
const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto');
const root='/tmp/neo-access-evidence';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const record=new RegExp('^'+uuid+'\\.json$'),trace=new RegExp('^traces/'+uuid+'\\.jsonl$');
const valid=name=>record.test(name)||trace.test(name);
function stat(name){if(!valid(name))throw Error();const file=p.join(root,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024||fs.realpathSync(file)!==file)throw Error();return s;}
try{
 if(fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())throw Error();
 if(process.argv[1]==='list'){
  const json=fs.readdirSync(root).filter(name=>record.test(name)).sort();
  if(json.length>1000)throw Error();let total=0;const files=[];
  for(const name of json){const names=[name,'traces/'+name.replace(/\.json$/,'.jsonl')];for(const relative of names){const s=stat(relative);total+=s.size;files.push({name:relative,size:s.size});}}
  if(total>64*1024*1024)throw Error();process.stdout.write(JSON.stringify({files,total}));
 }else if(process.argv[1]==='read'){
  const name=process.argv[2],before=stat(name),bytes=fs.readFileSync(p.join(root,name)),after=stat(name);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||bytes.length!==after.size)throw Error();
  process.stdout.write(JSON.stringify({name,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')}));
 }else throw Error();
}catch{process.stderr.write('Permission evidence could not be read safely.');process.exitCode=1;}
`;

interface Meta { name: string; namespace?: string; uid: string; generation?: number; annotations?: Record<string, string>; ownerReferences?: { kind: string; uid: string; controller?: boolean }[] }
interface Deployment { metadata: Meta; spec: { replicas: number; selector: { matchLabels: Record<string, string> }; template: { spec: { containers: { name: string; image: string }[] } } }; status: { observedGeneration: number; readyReplicas: number; updatedReplicas: number } }
interface Pod { metadata: Meta; spec: { containers: { name: string; image: string }[] }; status: { phase: string; podIP: string; conditions: { type: string; status: string }[] } }
interface CaptureReceipt { version: 1; targetId: string; context: string; namespace: string; deploymentUid: string; pod: string; podUid: string; directory: string; files: number; bytes: number; capturedAt: string; loopback: { localhostStatus: number; podIpReachable: boolean } }

function kubectl(target: IdentityTarget, args: string[]): Promise<string> {
  return command('kubectl', ['--kubeconfig', target.kubeconfig, '--context', target.context, '--namespace', target.namespace, ...args], 30_000);
}
async function ownedPod(target: IdentityTarget): Promise<{ deployment: Deployment; pod: Pod }> {
  const deployment = JSON.parse(await kubectl(target, ['get', 'deployment', 'neo', '--output=json'])) as Deployment;
  assert.equal(deployment.metadata.annotations?.['footprint-iac.dev/owner'], fingerprint({ stack: 'neo-identity-' + target.id, id: 'neo-app' }));
  assert.equal(deployment.metadata.namespace, target.namespace);
  assert.deepEqual(deployment.spec.selector.matchLabels, { 'app.kubernetes.io/instance': target.namespace });
  assert.ok(deployment.metadata.uid && deployment.status.observedGeneration >= deployment.metadata.generation!);
  assert.ok(deployment.status.readyReplicas >= deployment.spec.replicas && deployment.status.updatedReplicas >= deployment.spec.replicas);
  const selector = '--selector=app.kubernetes.io/instance=' + target.namespace;
  const replicaSets = JSON.parse(await kubectl(target, ['get', 'replicasets', selector, '--output=json'])) as { items: { metadata: Meta }[] };
  const owners = new Set(replicaSets.items.filter(set => set.metadata.ownerReferences?.some(owner => owner.kind === 'Deployment' && owner.uid === deployment.metadata.uid && owner.controller)).map(set => set.metadata.uid));
  const pods = JSON.parse(await kubectl(target, ['get', 'pods', selector, '--output=json'])) as { items: Pod[] };
  const nodeImage = deployment.spec.template.spec.containers.find(container => container.name === 'node')?.image;
  const pod = pods.items.find(pod => pod.metadata.namespace === target.namespace && pod.metadata.ownerReferences?.some(owner => owner.kind === 'ReplicaSet' && owners.has(owner.uid) && owner.controller)
    && pod.status.phase === 'Running' && pod.status.conditions.some(condition => condition.type === 'Ready' && condition.status === 'True')
    && pod.spec.containers.find(container => container.name === 'node')?.image === nodeImage);
  assert.ok(pod?.metadata.uid && pod.status.podIP, 'A ready owned Neo pod is required for permission evidence');
  return { deployment, pod };
}

/** Reads only two fixed HTTP health addresses from the existing Node container; opens no listeners. */
async function verifySidecarLoopback(target: IdentityTarget, pod: Pod): Promise<CaptureReceipt['loopback']> {
  const script = `const ip=process.argv[1];if(!/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(ip))process.exit(1);` +
    `(async()=>{const r=await fetch('http://127.0.0.1:8000/healthz',{signal:AbortSignal.timeout(3000),redirect:'error'});const b=await r.json();if(r.status!==200||b.status!=='ok')throw Error();let reachable=false;try{await fetch('http://'+ip+':8000/healthz',{signal:AbortSignal.timeout(3000),redirect:'error'});reachable=true}catch{}process.stdout.write(JSON.stringify({localhostStatus:r.status,podIpReachable:reachable}))})().catch(()=>process.exitCode=1);`;
  const result = JSON.parse(await kubectl(target, ['exec', pod.metadata.name, '--container=node', '--', 'node', '-e', script, pod.status.podIP])) as CaptureReceipt['loopback'];
  assert.equal(result.localhostStatus, 200); assert.equal(result.podIpReachable, false, 'Python must remain reachable only on Pod loopback');
  return result;
}

/** Capture pairs only after their complete JSON snapshot exists. Never reads directory fixtures, credentials or process environments. */
export async function captureNeoPermissionEvidence(target: IdentityTarget): Promise<CaptureReceipt> {
  const { deployment, pod } = await ownedPod(target);
  const execute = (args: string[]) => kubectl(target, ['exec', pod.metadata.name, '--container=node', '--', 'node', '-e', podScript, ...args]);
  const manifest = JSON.parse(await execute(['list'])) as { files: { name: string; size: number }[]; total: number };
  assert.ok(manifest.files.length > 0 && manifest.files.length <= 2000 && manifest.total <= 64 * 1024 * 1024);
  const directory = join(target.directory, 'app-policy', pod.metadata.uid);
  await mkdir(join(directory, 'traces'), { recursive: true, mode: 0o700 });
  let bytes = 0;
  for (const file of manifest.files) {
    assert.ok((recordName.test(file.name) || traceName.test(file.name)) && file.size >= 0 && file.size <= 8 * 1024 * 1024);
    const result = JSON.parse(await execute(['read', file.name])) as { name: string; size: number; sha256: string; data: string };
    assert.equal(result.name, file.name); assert.equal(result.size, file.size); assert.ok(Number.isSafeInteger(result.size) && result.size <= 8 * 1024 * 1024);
    const data = Buffer.from(result.data, 'base64');
    assert.equal(data.length, result.size); assert.equal(createHash('sha256').update(data).digest('hex'), result.sha256);
    const path = join(directory, file.name);
    try { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; assert.ok((await privateFile(path)).equals(data)); }
    bytes += data.length; assert.ok(bytes <= 64 * 1024 * 1024);
  }
  const after = await ownedPod(target);
  assert.equal(after.deployment.metadata.uid, deployment.metadata.uid); assert.equal(after.pod.metadata.uid, pod.metadata.uid, 'The application changed during evidence capture');
  const receipt: CaptureReceipt = { version: 1, targetId: target.id, context: target.context, namespace: target.namespace,
    deploymentUid: deployment.metadata.uid, pod: pod.metadata.name, podUid: pod.metadata.uid, directory, files: manifest.files.length, bytes,
    capturedAt: new Date().toISOString(), loopback: await verifySidecarLoopback(target, pod) };
  await writeFile(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}

async function main() {
  const targetPath = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  const offline = process.argv.includes('--offline');
  if (offline && process.argv.includes('--capture-only')) throw new Error('Offline verification cannot capture live application evidence');
  const target = offline ? await loadStoredIdentityTarget(targetPath) : await loadIdentityTarget(targetPath);
  if (process.argv.includes('--capture-only')) {
    console.log(JSON.stringify({ capture: await captureNeoPermissionEvidence(target) }, null, 2)); return;
  }
  if (!offline) await captureNeoPermissionEvidence(target);
  console.log(JSON.stringify(await proveIdentityAcceptance(target), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Identity acceptance proof failed; inspect private evidence and target state.'); process.exitCode = 1; });
}

async function privateFile(path: string, maximum = 16 * 1024 * 1024): Promise<Buffer> {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum && await realpath(path) === path);
  return readFile(path);
}

/** Offline proof admits only cached metadata at the owning package's private artifact paths. No provider or fixture-file reads. */
export async function loadStoredIdentityTarget(path?: string, root = identityRoot): Promise<IdentityTarget> {
  const canonicalRoot = resolve(root), selected = resolve(path ?? join(canonicalRoot, 'latest.json'));
  assert.equal(await realpath(canonicalRoot), canonicalRoot);
  const target = validateIdentityTarget(JSON.parse((await privateFile(selected, 64 * 1024)).toString('utf8')), canonicalRoot);
  assert.ok([join(canonicalRoot, 'latest.json'), join(target.directory, 'target.json')].includes(selected));
  assert.equal(await realpath(target.directory), target.directory);
  assert.ok((await lstat(target.directory)).isDirectory());
  return target;
}

async function verifyNativeEvidence(path: string, tracePath: string, keys: readonly string[]): Promise<{ runId: string; commits: number; decision?: string; observations?: Record<string, { status: string; verdict: string }> }> {
  await privateFile(path); await privateFile(tracePath);
  const evidence = await loadEvidence(path);
  assert.deepEqual(replay(evidence).state, evidence.snapshot.sharedState);
  assert.equal(evidence.traceStatus?.flushed, true); assert.equal(evidence.traceStatus?.failed, 0);
  const file = readRecordFile(tracePath, { maxBytes: 16 * 1024 * 1024 });
  assert.deepEqual(file.unreadable, []);
  const stored = readStoredRecord(file.entries); assert.deepEqual(stored.unread, []);
  const native = stored.root(evidence.snapshot.runId!); assert.ok(native?.complete); assert.equal(native.gaps.length, 0);
  assert.deepEqual(stateAt(native, native.commitLog.length - 1).state, evidence.snapshot.sharedState);
  for (const key of keys) {
    const walked = backwalk(evidence, key);
    const required = key === 'outcome' ? ['policy', 'subject', 'action', 'resource', 'decision'] : ['request:' + key.slice(9), 'observation:' + key.slice(9)];
    for (const dependency of required) assert.ok(walked.text.includes(dependency), 'Native backwalk must reach its declared inputs and observation');
    await writeFile(path.replace(/\.json$/, '') + '.' + key.replaceAll(':', '-') + '.backwalk.txt', walked.text + '\n', { mode: 0o600 });
  }
  const state = evidence.snapshot.sharedState as Record<string, unknown>;
  const outcome = state.outcome as { effect?: string } | undefined;
  const checks = state.checks as Record<string, { status: string; observation: { verdict: string } }> | undefined;
  return { runId: evidence.runId, commits: native.commitLog.length,
    ...(outcome?.effect ? { decision: outcome.effect } : {}),
    ...(checks ? { observations: Object.fromEntries(Object.entries(checks).map(([id, check]) => [id, { status: check.status, verdict: check.observation.verdict }])) } : {}) };
}

interface LensSnapshot {
  run: { id: string; status: string; report: { evidencePath: string; tracePath: string } };
  identity: { id: string; status: string; report: { evidencePath: string; tracePath: string } };
}
/** Admit exact owned output paths; do not normalize aliases or allow an arbitrary Lens directory. */
function lensEvidenceRoot(target: IdentityTarget, identity: LensSnapshot['identity']): string {
  assert.ok(recordName.test(identity.id + '.json'));
  const root = lensEvidenceRoots.find(name => identity.report.evidencePath === join(target.directory, name, 'identity', identity.id + '.json'));
  assert.ok(root, 'Identity evidence must use an owned Lens output directory');
  assert.equal(identity.report.tracePath, join(target.directory, root, 'identity-traces', identity.id + '.jsonl'),
    'Identity evidence and native trace must use the same Lens output directory');
  return root;
}
async function verifyLensSequence(target: IdentityTarget) {
  const snapshots = await Promise.all(['baseline', 'outage', 'recovery'].map(async name => ({ name,
    state: JSON.parse((await privateFile(join(target.directory, 'lens-' + name + '.json'))).toString('utf8')) as LensSnapshot })));
  const baseline = snapshots[0]!.state;
  assert.equal(baseline.run.status, 'passed'); assert.ok(recordName.test(baseline.run.id + '.json'));
  const lensRoot = lensEvidenceRoot(target, baseline.identity);
  const deploymentPath = baseline.run.report.evidencePath;
  assert.ok(deploymentPath.startsWith(target.stateDirectory + '/') && /^run-[a-f0-9]{64}\.json$/.test(deploymentPath.slice(target.stateDirectory.length + 1)));
  assert.equal(baseline.run.report.tracePath, join(target.directory, 'deployment-traces', baseline.run.id + '.jsonl'));
  const deployment = await verifyNativeEvidence(deploymentPath, baseline.run.report.tracePath, []);
  assert.equal(deployment.runId, baseline.run.id);
  const runs = [];
  for (const { name, state } of snapshots) {
    assert.deepEqual(state.run, baseline.run, 'Identity failure and recovery must preserve the original deployment recording');
    assert.equal(state.identity.status, name === 'outage' ? 'failed' : 'passed'); assert.ok(recordName.test(state.identity.id + '.json'));
    assert.equal(lensEvidenceRoot(target, state.identity), lensRoot, 'All identity phases must use the same Lens output directory');
    const verified = await verifyNativeEvidence(state.identity.report.evidencePath, state.identity.report.tracePath, ['progress:guest-denied', 'progress:directory-available']);
    assert.equal(verified.runId, state.identity.id);
    assert.equal(verified.observations?.['guest-denied']?.verdict, name === 'outage' ? 'unavailable' : 'denied');
    assert.equal(verified.observations?.['guest-denied']?.status, name === 'outage' ? 'failed' : 'passed');
    assert.equal(verified.observations?.['directory-available']?.verdict, name === 'outage' ? 'unavailable' : 'available');
    runs.push({ phase: name, status: state.identity.status, ...verified });
  }
  assert.equal(new Set(runs.map(run => run.runId)).size, 3);
  return { originalDeploymentRunId: baseline.run.id, deployment, runs };
}

async function verifyApplicationPermissions(target: IdentityTarget) {
  const root = join(target.directory, 'app-policy'), pods = [];
  let allowed = 0, denied = 0, records = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink() && new RegExp('^' + UUID + '$').test(entry.name));
    const directory = join(root, entry.name), capture = JSON.parse((await privateFile(join(directory, 'capture.json'))).toString('utf8')) as CaptureReceipt;
    assert.equal(capture.targetId, target.id); assert.equal(capture.namespace, target.namespace); assert.equal(capture.context, target.context);
    assert.equal(capture.podUid, entry.name); assert.equal(capture.directory, directory);
    assert.equal(capture.loopback.localhostStatus, 200); assert.equal(capture.loopback.podIpReachable, false);
    const runs = [];
    for (const name of (await readdir(directory)).filter(name => recordName.test(name)).sort()) {
      const run = await verifyNativeEvidence(join(directory, name), join(directory, 'traces', name.replace(/\.json$/, '.jsonl')), ['outcome']);
      assert.equal(run.runId + '.json', name); assert.ok(run.decision === 'allowed' || run.decision === 'denied');
      records++; if (run.decision === 'allowed') allowed++; else denied++; runs.push(run);
    }
    assert.ok(runs.length > 0); pods.push({ capture, runs });
  }
  assert.ok(allowed > 0 && denied > 0, 'Real application records must contain both allowed and denied decisions');
  return { records, allowed, denied, pods };
}

/** Scan only private evidence. Fixture files, environment files and LDIF are never traversed or copied. */
async function scanEvidenceCredentials(target: IdentityTarget) {
  const credentials = JSON.parse((await privateFile(join(target.directory, 'credentials.json'), 64 * 1024)).toString('utf8')) as Record<string, unknown>;
  const canaries = Object.values(credentials); assert.ok(canaries.length >= 3 && canaries.every(value => typeof value === 'string' && value.length >= 24));
  const needles = (canaries as string[]).map(value => Buffer.from(value));
  const scope = ['state', 'deployment-traces', 'identity', 'identity-traces',
    ...lensEvidenceRoots.flatMap(root => [root + '/identity', root + '/identity-traces']), 'app-policy'];
  let files = 0, bytes = 0, occurrences = 0, jwtLikeOccurrences = 0;
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      const info = await lstat(directory);
      assert.ok(info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory);
      entries = await readdir(directory, { withFileTypes: true });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), 'Private evidence cannot redirect credential scanning');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      assert.ok(entry.isFile()); const data = await privateFile(path, 32 * 1024 * 1024);
      files++; bytes += data.length; assert.ok(files <= 10_000 && bytes <= 256 * 1024 * 1024);
      for (const needle of needles) if (data.includes(needle)) occurrences++;
      if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/.test(data.toString('utf8'))) jwtLikeOccurrences++;
    }
  }
  for (const name of scope) await walk(join(target.directory, name));
  assert.equal(occurrences, 0, 'Credential canaries must not occur in private execution evidence');
  assert.equal(jwtLikeOccurrences, 0, 'Complete bearer JWTs must not occur in private execution evidence');
  return { scope, files, bytes, credentialCanaries: needles.length, credentialOccurrences: occurrences, jwtLikeOccurrences };
}

/** All verification below is offline; replay and backwalking invoke no adapters or infrastructure operations. */
export async function proveIdentityAcceptance(target: IdentityTarget) {
  const lens = await verifyLensSequence(target), application = await verifyApplicationPermissions(target), credentialScan = await scanEvidenceCredentials(target);
  const proof = { version: 1, targetId: target.id, checkedAt: new Date().toISOString(), context: target.context, namespace: target.namespace,
    checks: { snapshotReplay: true, nativeJsonlReplay: true, authorizationBackwalk: true, identityObservationBackwalk: true,
      originalDeploymentUnchanged: true, pythonLoopbackOnly: true }, lens, application, credentialScan };
  const path = join(target.directory, 'proof/acceptance.json');
  await mkdir(join(target.directory, 'proof'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  return { path, targetId: target.id, originalDeploymentRunId: lens.originalDeploymentRunId,
    identityRuns: lens.runs.map(run => ({ phase: run.phase, status: run.status, runId: run.runId })),
    applicationRecords: application.records, allowed: application.allowed, denied: application.denied,
    credentialScan, checks: proof.checks };
}

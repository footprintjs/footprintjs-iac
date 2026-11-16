import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createSystemdHost } from '../src/deployment-strategy/host.ts';
import { SYSTEMD_HOST_PROGRAM } from '../src/deployment-strategy/host-program.ts';
import type { HostProcessRequest } from '../src/platform-access/types.ts';

const hash = 'a'.repeat(64);
const registration = [{ name: 'app.service', workingDirectory: '/opt/app' }];
const observation = (name = 'app.service', workingDirectory = '/opt/app') => ({
  name, exists: true, fragmentPath: `/etc/systemd/system/${name}`, fragmentDigest: hash,
  configurationDigest: hash, activeState: 'active', invocationId: 'b'.repeat(32), appliedSpecDigest: null,
  workingDirectory,
});
const projected = (name = 'app.service') => { const { workingDirectory, ...unit } = observation(name); return unit; };

test('generic host captures explicit unit directories and uses the bounded fixed runner protocol', async () => {
  const requests: HostProcessRequest[] = [], units = structuredClone(registration);
  const host = createSystemdHost({ units, sudo: false, runner: async request => {
    requests.push(request); return { code: 0, stdout: JSON.stringify({ identityDigest: hash, units: [observation()] }) };
  } });
  units[0]!.workingDirectory = '/other';
  const result = await host.inspect();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.file, 'python3');
  assert.deepEqual(requests[0]!.args, ['-c', SYSTEMD_HOST_PROGRAM]);
  assert.equal(requests[0]!.maxOutputBytes, 256 * 1024); assert.equal(requests[0]!.timeoutMs, 90_000);
  assert.deepEqual(JSON.parse(requests[0]!.input), { operation: 'inspect', units: ['app.service'], workingDirectories: { 'app.service': '/opt/app' } });
  assert.deepEqual(result, { identityDigest: hash, units: [projected()] });
  assert.equal((await host.inspectBoundary()).units[0]!.workingDirectory, '/opt/app');
  assert.doesNotMatch(SYSTEMD_HOST_PROGRAM, /Neo|neo-systemd|repoDirectory/);
});

test('unregistered units, implicit names and nonabsolute directories fail before a runner is called', async () => {
  let calls = 0;
  const runner = async () => { calls++; return { code: 0, stdout: '{"ok":true}' }; };
  for (const units of [[{ name: 'app', workingDirectory: '/opt/app' }], [{ name: '--bad.service', workingDirectory: '/opt/app' }], [{ name: 'app.service', workingDirectory: 'relative' }], [...registration, ...registration]]) {
    assert.throws(() => createSystemdHost({ units, runner }));
  }
  const host = createSystemdHost({ units: registration, runner });
  await assert.rejects(() => host.applyUnit!({ unit: 'other.service', desiredSpecDigest: hash, releaseDigest: hash },
    { operationId: 'one', expectedIdentityDigest: hash, expectedUnit: projected() }));
  assert.equal(calls, 0);
});

test('wrong working directories, unknown fields and private provider errors are refused without disclosure', async () => {
  for (const value of [{ identityDigest: hash, units: [observation('app.service', '/unrelated')] },
    { identityDigest: hash, units: [{ ...observation(), privateValue: 'PRIVATE_SENTINEL' }] }]) {
    const host = createSystemdHost({ units: registration, runner: async () => ({ code: 0, stdout: JSON.stringify(value) }) });
    await assert.rejects(() => host.inspect(), error => error instanceof Error && error.message === 'systemd-host-unavailable' && !JSON.stringify(error).includes('PRIVATE_SENTINEL'));
  }
  const host = createSystemdHost({ units: registration, runner: async () => { throw Error('PRIVATE_PROVIDER_SENTINEL'); } });
  await assert.rejects(() => host.inspect(), error => error instanceof Error && error.message === 'systemd-host-unavailable' && !JSON.stringify(error).includes('PRIVATE_PROVIDER_SENTINEL'));
});

test('group effects require the complete registered ordered group and exact observations', async () => {
  const requests: HostProcessRequest[] = [], units = [...registration, { name: 'worker.service', workingDirectory: '/opt/worker' }];
  const host = createSystemdHost({ units, sudo: false, runner: async request => { requests.push(request); return { code: 0, stdout: '{"ok":true}' }; } });
  const request = { units: units.map(unit => unit.name), desiredSpecDigest: hash, releaseDigest: hash };
  const context = { operationId: 'one', expectedIdentityDigest: hash, expectedUnits: units.map(unit => projected(unit.name)) };
  await host.applyUnits!(request, context);
  assert.equal(JSON.parse(requests[0]!.input).operation, 'apply-group');
  await assert.rejects(() => host.applyUnits!({ ...request, units: ['app.service'] }, context));
  await assert.rejects(() => host.applyUnits!({ ...request, units: [...request.units].reverse() }, context));
  assert.equal(requests.length, 1);
});

function python(fixture: string): Record<string, unknown> {
  const definitions = SYSTEMD_HOST_PROGRAM.slice(0, SYSTEMD_HOST_PROGRAM.lastIndexOf('try:main()'));
  const result = spawnSync('python3', ['-c', definitions + '\n' + fixture], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim());
}

test('real Python inspection refuses absent required environment files and admits explicit optional absence', () => {
  for (const optional of ['no', 'yes']) {
    const value = python(String.raw`
import tempfile,types
with tempfile.TemporaryDirectory() as root:
 fragment=pathlib.Path(root)/'app.service';fragment.write_text('[Service]\nExecStart=/bin/true\n')
 missing=str(pathlib.Path(root)/'environment')
 text='Id=app.service\nLoadState=loaded\nFragmentPath='+str(fragment)+'\nDropInPaths=\nEnvironmentFiles='+missing+' (ignore_errors=OPTIONAL)\nWorkingDirectory=/opt/app\nUser=app\nMainPID=0\nInvocationID=\nNeedDaemonReload=no\nActiveState=inactive\n'
 run=lambda args:types.SimpleNamespace(returncode=0,stdout=text)
 try:
  inspect_unit('app.service');print('{"admitted":true}')
 except Exception:print('{"admitted":false}')
`.replace('OPTIONAL', optional));
    assert.equal(value.admitted, optional === 'yes');
  }
});

const applyFixture = String.raw`
import io,types,tempfile
identity='a'*64
units=['app.service','worker.service']
def fact(name):
 return {'name':name,'exists':True,'fragmentPath':'/etc/systemd/system/'+name,'fragmentDigest':'b'*64,'configurationDigest':'c'*64,'activeState':'active','invocationId':'1'*32,'appliedSpecDigest':None,'workingDirectory':'/opt/'+('app' if name=='app.service' else 'worker')}
facts={name:fact(name) for name in units}
expected=[projected(facts[name]) for name in units]
payload={'operation':'apply-group','units':units,'workingDirectories':{'app.service':'/opt/app','worker.service':'/opt/worker'},'request':{'units':units,'desiredSpecDigest':'d'*64,'releaseDigest':'e'*64},'context':{'operationId':'one','expectedIdentityDigest':identity,'expectedUnits':expected}}
machine=lambda:identity
inspect_unit=lambda name:dict(facts[name])
`;

test('real Python group revalidation and directory checks precede every marker write', () => {
  for (const change of ["facts['worker.service']['configurationDigest']='f'*64", "facts['worker.service']['workingDirectory']='/other'"]) {
    const value = python(applyFixture + '\n' + change + String.raw`
called=[]
def forbidden(*args):
 called.append(True);raise ValueError('no marker write allowed')
marker_content=forbidden
sys.stdin=io.StringIO(json.dumps(payload))
try:main();print('{"admitted":true}')
except Exception:print(json.dumps({'admitted':False,'markerCalls':len(called)}))
`);
    assert.equal(value.admitted, false); assert.equal(value.markerCalls, 0);
  }
});

test('real Python marker writes are atomic and coupled services use one dependency-respecting restart', () => {
  const value = python(applyFixture + String.raw`
commands=[]
with tempfile.TemporaryDirectory() as root:
 marker_path=lambda name:pathlib.Path(root).resolve()/(name+'.d')/MANAGED
 def fake_run(args):
  commands.append(args)
  if args[:2]==['systemctl','restart']:
   for name in units:facts[name]['appliedSpecDigest']='d'*64
  return types.SimpleNamespace(returncode=0,stdout='')
 run=fake_run
 sys.stdin=io.StringIO(json.dumps(payload))
 import contextlib
 with contextlib.redirect_stdout(io.StringIO()):main()
 print(json.dumps({'commands':commands,'markers':[marker_path(name).read_text().splitlines()[0] for name in units],'temporaryFiles':list(str(p) for p in pathlib.Path(root).rglob('.footprint-iac-*'))}))
`);
  assert.deepEqual(value.commands, [['systemctl', 'daemon-reload'], ['systemctl', 'restart', 'app.service', 'worker.service']]);
  assert.deepEqual(value.markers, ['# Managed by footprint-iac systemd deployment v1', '# Managed by footprint-iac systemd deployment v1']);
  assert.deepEqual(value.temporaryFiles, []);
});

test('native Python phases perform one command boundary each and revalidate between marker writes and restart',()=>{
  const value=python(applyFixture+String.raw`
import contextlib
commands=[];outputs=[]
with tempfile.TemporaryDirectory() as root:
 marker_path=lambda name:pathlib.Path(root).resolve()/(name+'.d')/MANAGED
 def fake_run(args):
  commands.append(args)
  if args[:2]==['systemctl','restart']:
   for name in units:facts[name]['appliedSpecDigest']='d'*64
  return types.SimpleNamespace(returncode=0,stdout='')
 run=fake_run
 for phase in ['revalidate','configure','reload','start','observe']:
  payload['operation']='flow-'+phase
  if phase=='observe':payload['selectedUnit']='worker.service'
  sys.stdin=io.StringIO(json.dumps(payload))
  with contextlib.redirect_stdout(io.StringIO()) as output:main()
  outputs.append(json.loads(output.getvalue()))
 print(json.dumps({'commands':commands,'outputs':outputs}))
`);
  assert.deepEqual(value.commands,[['systemctl','daemon-reload'],['systemctl','restart','app.service','worker.service']]);
  assert.equal((value.outputs as any[]).at(-1).unit.name,'worker.service');
  const refused=python(applyFixture+String.raw`
import contextlib
commands=[]
with tempfile.TemporaryDirectory() as root:
 marker_path=lambda name:pathlib.Path(root).resolve()/(name+'.d')/MANAGED
 payload['operation']='flow-configure';sys.stdin=io.StringIO(json.dumps(payload))
 with contextlib.redirect_stdout(io.StringIO()):main()
 facts['worker.service']['configurationDigest']='f'*64
 run=lambda args:(commands.append(args) or types.SimpleNamespace(returncode=0,stdout=''))
 payload['operation']='flow-start';sys.stdin=io.StringIO(json.dumps(payload))
 try:
  with contextlib.redirect_stdout(io.StringIO()):main()
  admitted=True
 except Exception:admitted=False
 print(json.dumps({'admitted':admitted,'commands':commands}))
`);
  assert.deepEqual(refused,{admitted:false,commands:[]});
});

test('real Python inspection measures only the active process marker and never publishes environment values', () => {
  const value = python(String.raw`
import tempfile,types
with tempfile.TemporaryDirectory() as root:
 fragment=pathlib.Path(root)/'app.service';fragment.write_text('[Service]\nEnvironment="FOOTPRINT_IAC_SPEC_DIGEST='+'d'*64+'"\n')
 text='Id=app.service\nLoadState=loaded\nFragmentPath='+str(fragment)+'\nDropInPaths=\nEnvironmentFiles=\nWorkingDirectory=/opt/app\nUser=app\nMainPID=123\nInvocationID='+'1'*32+'\nNeedDaemonReload=no\nActiveState=active\n'
 run=lambda args:types.SimpleNamespace(returncode=0,stdout=text)
 original_path=pathlib.Path
 class ProcessEnvironment:
  def read_bytes(self):return b'PASSWORD=PRIVATE_PROCESS_PASSWORD\x00FOOTPRINT_IAC_SPEC_DIGEST='+b'a'*64+b'\x00'
 pathlib=types.SimpleNamespace(Path=lambda path:ProcessEnvironment() if str(path)=='/proc/123/environ' else original_path(path))
 print(json.dumps(inspect_unit('app.service')))
`);
  assert.equal(value.appliedSpecDigest, hash);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_PROCESS_PASSWORD|PASSWORD|environment/);
});

test('an unowned dangling marker symlink is refused without replacing the link', () => {
  const value = python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as root:
 path=pathlib.Path(root)/MANAGED;path.symlink_to(pathlib.Path(root)/'absent')
 try:validate_marker(path);admitted=True
 except Exception:admitted=False
 print(json.dumps({'admitted':admitted,'stillSymlink':path.is_symlink()}))
`);
  assert.deepEqual(value, { admitted: false, stillSymlink: true });
});

test('real Python manager job inspection accepts measured empty jobs and refuses missing or malformed properties',()=>{
  for(const [property,expected] of [['Job=',true],['Job=0',true],['Job=17 /org/freedesktop/systemd1/job/17',true],['',false],['Job=unknown',false]] as const){
    const value=python(applyFixture+String.raw`
payload['operation']='inspect-jobs'
run=lambda args:types.SimpleNamespace(returncode=0,stdout='Id='+args[-1]+'\n'+PROPERTY+'\n')
sys.stdin=io.StringIO(json.dumps(payload))
import contextlib
try:
 with contextlib.redirect_stdout(io.StringIO()) as output:main()
 print(json.dumps({'admitted':True,'result':json.loads(output.getvalue())}))
except Exception:print('{"admitted":false}')
`.replace('PROPERTY',JSON.stringify(property)));
    assert.equal(value.admitted,expected,property||'missing Job');
    if(property==='Job='||property==='Job=0')assert.deepEqual((value.result as any).jobs,[{unit:'app.service',jobId:null},{unit:'worker.service',jobId:null}]);
    if(property.startsWith('Job=17'))assert.equal((value.result as any).jobs[0].jobId,'17');
  }
});

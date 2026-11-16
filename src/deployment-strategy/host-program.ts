/** Fixed trusted host recipe. No command, script or credential comes from public request data. */
export const SYSTEMD_HOST_PROGRAM = String.raw`
import hashlib,json,os,pathlib,re,shlex,stat,subprocess,sys,tempfile,time
MARKER = '# Managed by footprint-iac systemd deployment v1'
MANAGED = '90-footprint-iac.conf'
HEX = re.compile(r'^[a-f0-9]{64}$')
NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.@-]{0,126}\.service$')
def sha(value): return hashlib.sha256(value).hexdigest()
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def run(args):
 p=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=30)
 return p
def path_bytes(path):
 p=pathlib.Path(path)
 if not p.is_absolute() or p.is_symlink() or not p.is_file(): raise ValueError('regular file required')
 return p.read_bytes()
def machine():
 value=pathlib.Path('/etc/machine-id').read_text().strip()
 if not re.fullmatch(r'[a-fA-F0-9]{32}',value): raise ValueError('machine identity required')
 if not pathlib.Path('/run/systemd/system').is_dir(): raise ValueError('systemd manager required')
 return sha(value.lower().encode())
def marker_path(name): return pathlib.Path('/etc/systemd/system')/(name+'.d')/MANAGED
def marker_content(spec,release):
 if not HEX.fullmatch(spec) or not HEX.fullmatch(release): raise ValueError('digest required')
 return (MARKER+'\n[Service]\nEnvironment="FOOTPRINT_IAC_SPEC_DIGEST='+spec+'"\nEnvironment="FOOTPRINT_IAC_RELEASE_DIGEST='+release+'"\n').encode()
def validate_marker(path):
 if path.is_symlink(): raise ValueError('owned regular marker required')
 if not path.exists(): return
 data=path_bytes(path)
 lines=data.decode().splitlines()
 if len(lines)!=4 or lines[0]!=MARKER or lines[1]!='[Service]': raise ValueError('owned marker required')
 if not re.fullmatch(r'Environment="FOOTPRINT_IAC_SPEC_DIGEST=[a-f0-9]{64}"',lines[2]) or not re.fullmatch(r'Environment="FOOTPRINT_IAC_RELEASE_DIGEST=[a-f0-9]{64}"',lines[3]): raise ValueError('owned marker required')
def inspect_unit(name):
 if not NAME.fullmatch(name): raise ValueError('registered name required')
 props=['Id','LoadState','FragmentPath','DropInPaths','EnvironmentFiles','WorkingDirectory','User','MainPID','InvocationID','NeedDaemonReload','ActiveState']
 p=run(['systemctl','show','--no-pager','--property='+','.join(props),name])
 values=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
 if values.get('LoadState')=='not-found':
  return {'name':name,'exists':False,'fragmentPath':None,'fragmentDigest':None,'configurationDigest':None,'activeState':values.get('ActiveState','inactive'),'invocationId':None,'appliedSpecDigest':None,'workingDirectory':None}
 if p.returncode or values.get('LoadState')!='loaded' or values.get('Id')!=name or values.get('NeedDaemonReload')!='no': raise ValueError('loaded manager configuration required')
 fragment=values.get('FragmentPath','')
 data=path_bytes(fragment)
 dropins=[]
 owned=marker_path(name)
 for path in shlex.split(values.get('DropInPaths','')):
  if pathlib.Path(path)==owned:
   validate_marker(owned)
  else: dropins.append({'path':path,'digest':sha(path_bytes(path))})
 envfiles=[]
 for path,optional in re.findall(r'(?:^| )([^ ]+) \(ignore_errors=(yes|no)\)',values.get('EnvironmentFiles','')):
  candidate=pathlib.Path(path)
  if not candidate.exists() and optional!='yes': raise ValueError('required environment file missing')
  envfiles.append({'path':path,'optional':optional=='yes','digest':sha(path_bytes(path)) if candidate.exists() else None})
 working=values.get('WorkingDirectory','') or '/'
 configuration=sha(canonical({'fragmentPath':fragment,'fragmentDigest':sha(data),'dropins':dropins,'environmentFiles':envfiles,'workingDirectory':working,'user':values.get('User','')}))
 pid=int(values.get('MainPID','0') or '0'); applied=None
 if pid>0:
  for entry in pathlib.Path('/proc/%d/environ'%pid).read_bytes().split(bytes([0])):
   prefix=b'FOOTPRINT_IAC_SPEC_DIGEST='
   if entry.startswith(prefix):
    value=entry[len(prefix):].decode('ascii')
    if not HEX.fullmatch(value): raise ValueError('measured marker required')
    applied=value
 invocation=values.get('InvocationID','') or None
 if invocation is not None and not re.fullmatch(r'[a-f0-9]{32}',invocation): raise ValueError('invocation identity required')
 return {'name':name,'exists':True,'fragmentPath':fragment,'fragmentDigest':sha(data),'configurationDigest':configuration,'activeState':values.get('ActiveState','unknown'),'invocationId':invocation,'appliedSpecDigest':applied,'workingDirectory':working}
def inspect_registered(name, directories):
 value=inspect_unit(name)
 if value['exists'] and (not isinstance(value['workingDirectory'],str) or os.path.normpath(value['workingDirectory'])!=directories[name]): raise ValueError('registered working directory required')
 return value
def projected(unit): return {key:value for key,value in unit.items() if key!='workingDirectory'}
def main():
 request=json.loads(sys.stdin.read(65537))
 units=request.get('units')
 if not isinstance(units,list) or not units or len(units)>32 or len(set(units))!=len(units) or any(not isinstance(name,str) or not NAME.fullmatch(name) for name in units): raise ValueError('registered units required')
 directories=request.get('workingDirectories')
 if not isinstance(directories,dict) or set(directories)!=set(units) or any(not isinstance(path,str) or not path.startswith('/') or len(path)>4096 or os.path.normpath(path)!=path or any(ord(c)<32 or ord(c)==127 for c in path) for path in directories.values()): raise ValueError('explicit working directories required')
 identity=machine()
 if request.get('operation')=='inspect':
  print(json.dumps({'identityDigest':identity,'units':[inspect_registered(name,directories) for name in units]},separators=(',',':')));return
 if request.get('operation')=='inspect-jobs':
  jobs=[]
  for name in units:
   inspect_registered(name,directories)
   result=run(['systemctl','show','--no-pager','--property=Id,Job',name])
   values=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
   if result.returncode or values.get('Id')!=name or 'Job' not in values or not re.fullmatch(r'(?:[0-9]+(?: /org/freedesktop/systemd1/job/[0-9]+)?)?',values['Job']): raise ValueError('measured manager job required')
   job=values['Job'].split(' ')[0]
   jobs.append({'unit':name,'jobId':None if job in ['', '0'] else job})
  print(json.dumps({'identityDigest':identity,'jobs':jobs},separators=(',',':')));return
 if request.get('operation') not in ['apply','apply-group']: raise ValueError('fixed operation required')
 action=request['request']; context=request['context']
 names=action['units'] if request['operation']=='apply-group' else [action['unit']]
 expected=context['expectedUnits'] if request['operation']=='apply-group' else [context['expectedUnit']]
 if not isinstance(names,list) or not names or len(names)!=len(set(names)) or any(name not in units for name in names) or len(expected)!=len(names): raise ValueError('approved unit group required')
 if request['operation']=='apply-group' and names!=units: raise ValueError('complete approved group required')
 if identity!=context['expectedIdentityDigest'] or [projected(inspect_registered(name,directories)) for name in names]!=expected: raise ValueError('fresh reviewed identities required')
 content=marker_content(action['desiredSpecDigest'],action['releaseDigest'])
 for name in names:
  path=marker_path(name)
  if path.parent.exists() and (path.parent.is_symlink() or not path.parent.is_dir() or path.parent.resolve()!=path.parent): raise ValueError('managed directory required')
  validate_marker(path)
 for name in names:
  path=marker_path(name);path.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
  if path.parent.resolve()!=path.parent: raise ValueError('canonical managed directory required')
  descriptor,temporary=tempfile.mkstemp(prefix='.footprint-iac-',dir=path.parent)
  try:
   with os.fdopen(descriptor,'wb') as output:
    output.write(content);output.flush();os.fchmod(output.fileno(),0o644);os.fsync(output.fileno())
   os.replace(temporary,path)
   directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
   try:os.fsync(directory)
   finally:os.close(directory)
  finally:
   if os.path.exists(temporary):os.unlink(temporary)
 for command in [['systemctl','daemon-reload'],['systemctl','restart']+names]:
  if run(command).returncode:raise ValueError('systemd effect unconfirmed')
 for name in names:
  observed=inspect_registered(name,directories)
  if observed['activeState']!='active' or observed['appliedSpecDigest']!=action['desiredSpecDigest']:raise ValueError('active process marker unconfirmed')
 print('{"ok":true}')
try:main()
except Exception:
 print('systemd-host-operation-refused',file=sys.stderr);sys.exit(1)
`;

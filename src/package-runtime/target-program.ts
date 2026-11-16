/** Fixed filesystem recipe. Input describes bounded files, never executable commands or archive extraction. */
export const FILE_RELEASE_PROGRAM=String.raw`
import base64,fcntl,hashlib,json,os,pathlib,re,shutil,stat,sys,tempfile,uuid
HEX=re.compile(r'^[a-f0-9]{64}$'); ID=re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$')
ACCESS=False
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def sha(value):return hashlib.sha256(value).hexdigest()
def syncdir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def regular(path):
 s=path.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1:raise ValueError('regular file required')
 return s
def readjson(path):
 if regular(path).st_size>8388608:raise ValueError('bounded metadata required')
 return json.loads(path.read_text())
def writejson(path,value):
 fd,name=tempfile.mkstemp(prefix='.write-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(canonical(value));f.flush();os.fchmod(f.fileno(),0o600);os.fsync(f.fileno())
  os.replace(name,path);syncdir(path.parent)
 finally:
  if os.path.exists(name):os.unlink(name)
def canonicaldir(path):
 if not path.is_absolute() or path.resolve()!=path or path.is_symlink():raise ValueError('canonical directory required')
 if path.exists() and not stat.S_ISDIR(path.lstat().st_mode):raise ValueError('directory required')
def manifest(value):
 if not isinstance(value,dict) or set(value)!=set(['version','kind','id','files','digest']) or value['version']!=1 or value['kind']!='directory-package' or not ID.fullmatch(value['id']):raise ValueError('manifest required')
 if not isinstance(value['files'],list) or not value['files'] or len(value['files'])>4096:raise ValueError('bounded files required')
 total=0;names=[]
 for f in value['files']:
  if set(f)!=set(['path','digest','bytes','mode']) or not isinstance(f['path'],str) or not f['path'] or len(f['path'])>1024 or '\\' in f['path'] or any(ord(c)<32 or ord(c)==127 for c in f['path']):raise ValueError('relative file required')
  parts=f['path'].split('/')
  if any(part in ['','.','..','.git','.env'] or part.startswith('.env.') for part in parts) or f['path'].startswith('/') or f['path']=='.package.json':raise ValueError('relative file required')
  if not HEX.fullmatch(f['digest']) or type(f['bytes'])!=int or f['bytes']<0 or f['mode'] not in [420,493]:raise ValueError('file identity required')
  total+=f['bytes'];names.append(f['path'])
 if total>134217728 or names!=sorted(set(names),key=lambda n:n.encode('utf-16-be')) or any('/'.join(n.split('/')[:i]) in names for n in names for i in range(1,len(n.split('/')))):raise ValueError('bounded unique tree required')
 if sha(canonical({k:v for k,v in value.items() if k!='digest'}))!=value['digest']:raise ValueError('package digest differs')
 return value
def verify(root,digest):
 if not HEX.fullmatch(digest):raise ValueError('package digest required')
 path=root/'releases'/digest;canonicaldir(path)
 meta=regular(path/'.package.json')
 if meta.st_uid!=os.geteuid() or meta.st_mode&146:raise ValueError('sealed metadata required')
 m=manifest(readjson(path/'.package.json'))
 if m['digest']!=digest:raise ValueError('package identity changed')
 expected=set(f['path'] for f in m['files']);actual=set()
 for directory,dirs,files in os.walk(path,followlinks=False):
  info=pathlib.Path(directory).stat()
  if info.st_uid!=os.geteuid() or info.st_mode&146:raise ValueError('sealed directory changed')
  for name in dirs:
   if (pathlib.Path(directory)/name).is_symlink():raise ValueError('package link refused')
  for name in files:
   p=pathlib.Path(directory)/name;rel=p.relative_to(path).as_posix()
   if rel!='.package.json':actual.add(rel)
 if actual!=expected:raise ValueError('package file set changed')
 for f in m['files']:
  p=path/f['path'];s=regular(p)
  if s.st_uid!=os.geteuid() or s.st_size!=f['bytes'] or sha(p.read_bytes())!=f['digest'] or (493 if s.st_mode&73 else 420)!=f['mode'] or s.st_mode&146:raise ValueError('package file changed')
 return m
def machine():
 p=pathlib.Path('/etc/machine-id')
 return p.read_text().strip() if p.exists() else os.uname().nodename
def identity(root,id):
 s=root.stat();return sha(canonical({'id':id,'root':str(root),'device':s.st_dev,'inode':s.st_ino,'machine':machine(),'runtimeTraversal':ACCESS}))
def load(root,id):
 if root.stat().st_uid!=os.geteuid() or root.stat().st_mode&511!=(457 if ACCESS else 448):raise ValueError('private target ownership required')
 canonicaldir(root/'releases')
 if (root/'releases').stat().st_uid!=os.geteuid() or (root/'releases').stat().st_mode&511!=(457 if ACCESS else 448):raise ValueError('release store ownership changed')
 owner=readjson(root/'owner.json')
 if set(owner)!=set(['version','id','identityDigest','runtimeTraversal']) or owner['version']!=1 or owner['id']!=id or owner['runtimeTraversal']!=ACCESS or owner['identityDigest']!=identity(root,id):raise ValueError('target ownership changed')
 ledger=readjson(root/'operations.json')
 if set(ledger)!=set(['version','currentDigest','previousDigest','pending','operations']) or ledger['version']!=1 or not isinstance(ledger['operations'],list) or len(ledger['operations'])>256:raise ValueError('operation journal required')
 return owner,ledger
def current(root,ledger):
 path=root/'current';expected=ledger['currentDigest']
 if expected is None:
  if path.exists() or path.is_symlink():raise ValueError('unexpected current package')
 else:
  if not path.is_symlink() or os.readlink(path)!='releases/'+expected:raise ValueError('current package changed')
  verify(root,expected)
def inspect(root,id):
 if not root.exists():return {'id':id,'exists':False,'identityDigest':None,'currentDigest':None,'previousDigest':None,'pendingOperationId':None}
 canonicaldir(root);owner,ledger=load(root,id);current(root,ledger)
 return {'id':id,'exists':True,'identityDigest':owner['identityDigest'],'currentDigest':ledger['currentDigest'],'previousDigest':ledger['previousDigest'],'pendingOperationId':ledger['pending']['operationId'] if ledger['pending'] else None}
def enroll(root,id):
 if root.exists():
  canonicaldir(root)
  if not (root/'owner.json').exists():raise ValueError('target enrollment requires absent directory')
  return
 canonicaldir(root.parent)
 if root.parent.stat().st_mode&18:raise ValueError('private target parent required')
 mode=0o711 if ACCESS else 0o700
 root.mkdir(mode=mode);os.chmod(root,mode);(root/'releases').mkdir(mode=mode);os.chmod(root/'releases',mode)
 writejson(root/'owner.json',{'version':1,'id':id,'identityDigest':identity(root,id),'runtimeTraversal':ACCESS})
 writejson(root/'operations.json',{'version':1,'currentDigest':None,'previousDigest':None,'pending':None,'operations':[]})
 syncdir(root.parent)
def lock(root):
 p=root/'lock'
 if p.exists():regular(p)
 fd=os.open(p,os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600);fcntl.flock(fd,fcntl.LOCK_EX);return fd
def checkcontext(context,id):
 if set(context)!=set(['operationId','packageDigest','targetId']) or not ID.fullmatch(context['operationId']) or not HEX.fullmatch(context['packageDigest']) or context['targetId']!=id:raise ValueError('operation binding required')
def stage(root,id,request):
 m=manifest(request['manifest']);context=request['context'];checkcontext(context,id)
 if m['digest']!=context['packageDigest']:raise ValueError('package operation differs')
 before=request['before'];observed=inspect(root,id)
 if observed!=before or observed['pendingOperationId']:raise ValueError('target changed or outcome pending')
 enroll(root,id);fd=lock(root);temp=None
 try:
  observed=inspect(root,id)
  if before['exists'] and observed!=before or observed['pendingOperationId']:raise ValueError('target changed or outcome pending')
  dest=root/'releases'/m['digest']
  if dest.exists():verify(root,m['digest']);return observed
  items=request['files']
  if not isinstance(items,list) or len(items)!=len(m['files']):raise ValueError('complete package required')
  temp=root/'releases'/('.staging-'+str(uuid.uuid4()));temp.mkdir(mode=0o700)
  for f,item in zip(m['files'],items):
   if set(item)!=set(['path','content']) or item['path']!=f['path']:raise ValueError('package order differs')
   data=base64.b64decode(item['content'],validate=True)
   if len(data)!=f['bytes'] or sha(data)!=f['digest']:raise ValueError('package content changed')
   p=temp/f['path'];p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
   with open(p,'xb') as output:output.write(data);output.flush();os.fchmod(output.fileno(),365 if f['mode']==493 else 292);os.fsync(output.fileno())
  writejson(temp/'.package.json',m);os.chmod(temp/'.package.json',0o444)
  for directory,dirs,files in os.walk(temp,topdown=False):syncdir(pathlib.Path(directory));os.chmod(directory,0o555)
  os.rename(temp,dest);syncdir(dest.parent);verify(root,m['digest']);return inspect(root,id)
 finally:
  if temp is not None and temp.exists():
   for directory,dirs,files in os.walk(temp):os.chmod(directory,0o700)
   shutil.rmtree(temp)
  os.close(fd)
def activate(root,id,request):
 context=request['context'];checkcontext(context,id);fd=lock(root)
 try:
  before=request['before'];observed=inspect(root,id)
  if observed!=before or observed['pendingOperationId']:raise ValueError('target changed or outcome pending')
  owner,ledger=load(root,id)
  if any(op['operationId']==context['operationId'] for op in ledger['operations']) or len(ledger['operations'])>=256:raise ValueError('operation already used or history full')
  verify(root,context['packageDigest']);receipt={'operationId':context['operationId'],'packageDigest':context['packageDigest'],'previousDigest':ledger['currentDigest'],'identityDigest':owner['identityDigest']}
  ledger['pending']=receipt;writejson(root/'operations.json',ledger)
  link=root/('.current-'+str(uuid.uuid4()));os.symlink('releases/'+context['packageDigest'],link);os.replace(link,root/'current');syncdir(root)
  ledger['previousDigest']=receipt['previousDigest'];ledger['currentDigest']=context['packageDigest'];writejson(root/'operations.json',ledger)
  return receipt
 finally:os.close(fd)
def settle(root,id,request):
 context=request['context'];checkcontext(context,id);fd=lock(root)
 try:
  owner,ledger=load(root,id);current(root,ledger);receipt=request['receipt'];proof=request['proof']
  if receipt['operationId']!=context['operationId'] or receipt['packageDigest']!=context['packageDigest'] or receipt['identityDigest']!=owner['identityDigest'] or ledger['currentDigest']!=context['packageDigest'] or proof['outcome'] not in ['ready','verification-failed'] or not proof['runId'] or not HEX.fullmatch(proof['digest']):raise ValueError('settled native proof required')
  previous=proof.get('previousSettlement')
  if ledger['pending'] is None:
   last=ledger['operations'][-1] if ledger['operations'] else None
   if not last or any(last.get(k)!=v for k,v in receipt.items()) or previous!=last.get('proof') or previous.get('outcome')!='verification-failed':raise ValueError('exact prior failed settlement required')
   return {'ok':True}
  if ledger['pending']!=receipt or previous is not None:raise ValueError('exact pending receipt required')
  ledger['operations'].append({**receipt,'proof':proof});ledger['pending']=None;writejson(root/'operations.json',ledger);return {'ok':True}
 finally:os.close(fd)
def main():
 global ACCESS
 data=sys.stdin.read(190000001)
 if len(data)>190000000:raise ValueError('bounded payload required')
 request=json.loads(data);root=pathlib.Path(request['directory']);id=request['id'];operation=request['operation'];ACCESS=request['allowRuntimeTraversal']
 if type(ACCESS)!=bool:raise ValueError('registered runtime traversal policy required')
 if not ID.fullmatch(id) or str(root)=='/' or not root.is_absolute() or root.resolve()!=root or len(str(root))>4096:raise ValueError('registered canonical target required')
 canonicaldir(root)
 if operation=='inspect':result=inspect(root,id)
 elif operation=='stage':result=stage(root,id,request)
 elif operation=='activate':result=activate(root,id,request)
 elif operation=='settle':result=settle(root,id,request)
 else:raise ValueError('registered operation required')
 print(json.dumps(result,separators=(',',':')))
try:main()
except Exception:
 print('file-release-operation-refused',file=sys.stderr);sys.exit(1)
`;

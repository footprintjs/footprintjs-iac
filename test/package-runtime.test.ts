import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,link,lstat,mkdir,mkdtemp,readFile,readdir,readlink,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fingerprint} from '../src/util.ts';
import {runHostProcess} from '../src/platform-access/process.ts';
import {buildDirectoryPackage,createDirectoryPackageSource} from '../src/package-runtime/package.ts';
import {createFileReleaseTarget} from '../src/package-runtime/target.ts';
import {PackageActivationWorkflow} from '../src/package-runtime/workflow.ts';
import {readDirectoryPackageManifest,packageActivationProof} from '../src/package-runtime/data.ts';
import {backwalk,loadEvidence} from '../src/evidence.ts';
import type {DirectoryPackageSource,PackageActivationState,PackageReleaseTarget,PackageRuntimePort} from '../src/package-runtime/types.ts';
const digest='a'.repeat(64);
async function cleanup(path:string){try{for(const item of await readdir(path,{withFileTypes:true})){if(item.isDirectory()){await chmod(join(path,item.name),0o700);await cleanup(join(path,item.name));}}await chmod(path,0o700);await rm(path,{recursive:true,force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
async function fixture(t:test.TestContext){const directory=await realpath(await mkdtemp(join(tmpdir(),'iac-package-')));t.after(()=>cleanup(directory));const source=join(directory,'source');await mkdir(source);await mkdir(join(source,'nested'));await writeFile(join(source,'entry.mjs'),'console.log("v1");\n');await writeFile(join(source,'nested/data.txt'),'version one\n');const pack=await buildDirectoryPackage({id:'app',directory:source,paths:['entry.mjs','nested/data.txt']});const root=join(directory,'installed');return{directory,source,pack,root,target:createFileReleaseTarget({id:'app-host',directory:root})};}
function native(directory:string,source:DirectoryPackageSource,target:PackageReleaseTarget,runtime:PackageRuntimePort,id='install'){return new PackageActivationWorkflow({id,directory,package:source,target,runtime,configurationDigest:digest});}
function observed(source:DirectoryPackageSource,ready=true){return{runtimeId:'native-invocation-1',packageDigest:source.manifest.digest,ready,evidence:{method:'process-files' as const,digest,complete:true}};}

test('directory packages bind regular file bytes, reject links/unsafe paths, and recheck changed source content',async t=>{
 const f=await fixture(t);assert.deepEqual(f.pack.manifest.files.map(x=>x.path),['entry.mjs','nested/data.txt']);assert.equal(readDirectoryPackageManifest(f.pack.manifest).digest,f.pack.manifest.digest);
 await symlink('entry.mjs',join(f.source,'linked'));await link(join(f.source,'entry.mjs'),join(f.source,'hardlink'));
 for(const paths of [['../outside'],['/absolute'],['.env'],['.package.json'],['linked'],['hardlink'],['entry.mjs','entry.mjs']])await assert.rejects(()=>buildDirectoryPackage({id:'app',directory:f.source,paths}));
 await rm(join(f.source,'hardlink'));await writeFile(join(f.source,'entry.mjs'),'console.log("CHANGED");\n');let activated=0;
 const state=await native(join(f.directory,'attempt'),f.pack,f.target,{async activate(){activated++;},async observe(){return observed(f.pack);}}).start({operationId:'changed-source'});
 assert.equal(state.status,'failed');assert.equal(activated,0);assert.equal((await f.target.inspect()).exists,false);assert.equal(state.recording?.complete,true);
});

test('private source reconstruction is provider-free until read and preserves shared filesystem/content guards',async t=>{
 const f=await fixture(t),missing=join(f.directory,'not-present');const source=createDirectoryPackageSource({directory:missing,manifest:f.pack.manifest});assert.equal(source.manifest.digest,f.pack.manifest.digest);await assert.rejects(()=>source.read('entry.mjs'));
 const reconstructed=createDirectoryPackageSource({directory:f.source,manifest:f.pack.manifest});assert.equal(Buffer.from(await reconstructed.read('entry.mjs')).toString(),'console.log("v1");\n');await assert.rejects(()=>reconstructed.read('../outside'));
 await chmod(join(f.source,'entry.mjs'),0o755);await assert.rejects(()=>reconstructed.read('entry.mjs'));
});

test('actual file installation, atomic upgrade and explicit retained-package recovery use native stages',async t=>{
 const f=await fixture(t);const data=join(f.directory,'application-data');await writeFile(data,'KEEP USER DATA');let restarts=0;
 const runtime=(source:DirectoryPackageSource,ready=true):PackageRuntimePort=>({async activate(){restarts++;assert.equal(await readlink(join(f.root,'current')),'releases/'+source.manifest.digest);},async observe(){
  for(const file of source.manifest.files){const bytes=await readFile(join(f.root,'current',file.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.digest);}return observed(source,ready);
 }});
 const first=native(join(f.directory,'first'),f.pack,f.target,runtime(f.pack));const one=await first.start({operationId:'v1'});assert.equal(one.status,'ready');assert.equal(one.events.length,8);assert.equal(one.receipt?.previousDigest,null);
 assert.equal(await readFile(join(f.root,'current/nested/data.txt'),'utf8'),'version one\n');assert.equal((await lstat(join(f.root,'current/entry.mjs'))).mode&0o222,0);
 await writeFile(join(f.source,'entry.mjs'),'console.log("v2");\n');const twoPack=await buildDirectoryPackage({id:'app',directory:f.source,paths:['entry.mjs','nested/data.txt']});
 const two=await native(join(f.directory,'second'),twoPack,f.target,runtime(twoPack,false)).start({operationId:'v2'});assert.equal(two.status,'verification-failed');assert.equal(two.recording?.complete,true);assert.equal((await f.target.inspect()).pendingOperationId,null);assert.equal(two.receipt?.previousDigest,f.pack.manifest.digest);
 // Recovery uses retained verified content, not a rebuild of the original source directory.
 const retained:DirectoryPackageSource={manifest:f.pack.manifest,read:path=>readFile(join(f.root,'releases',f.pack.manifest.digest,path))};
 const recovered=await native(join(f.directory,'recovery'),retained,f.target,runtime(retained)).start({operationId:'recover-v1'});
 assert.equal(recovered.status,'ready');assert.equal(recovered.receipt?.previousDigest,twoPack.manifest.digest);assert.equal((await f.target.inspect()).currentDigest,f.pack.manifest.digest);
 assert.ok((await readdir(join(f.root,'releases'))).includes(twoPack.manifest.digest));assert.equal(await readFile(data,'utf8'),'KEEP USER DATA');assert.equal(restarts,3);
});

test('read-only reopening verifies native capture and never probes or repeats installation',async t=>{
 const f=await fixture(t);let calls=0;const runtime={async activate(){calls++;},async observe(){calls++;return observed(f.pack);}};
 const options=[join(f.directory,'attempt'),f.pack,f.target,runtime] as const;const instance=native(...options);const ready=await instance.start({operationId:'one'});assert.equal(ready.status,'ready');assert.equal(calls,2);
 const refusing:PackageReleaseTarget={id:f.target.id,async inspect(){throw Error('provider called on reopen');},async stage(){throw Error('provider called on reopen');},async activate(){throw Error('provider called on reopen');},async settle(){throw Error('provider called on reopen');}};
 const reopened=native(options[0],f.pack,refusing,{async activate(){throw Error('runtime called on reopen');},async observe(){throw Error('runtime called on reopen');}});
 assert.deepEqual(await reopened.snapshot(),ready);assert.deepEqual(await reopened.start({operationId:'one'}),ready);assert.equal(calls,2);
 const retained=JSON.parse(await readFile(join(options[0],'package-activation.json'),'utf8'));retained.observation.runtimeId='forged';await writeFile(join(options[0],'package-activation.json'),JSON.stringify(retained));await assert.rejects(()=>reopened.snapshot(),/native-receipt/);
});

test('every external package effect starts only after its native stage intent is synced',async t=>{
 const f=await fixture(t),directory=join(f.directory,'intent');const calls:string[]=[];
 const intent=async(id:string)=>{const journal=JSON.parse(await readFile(join(directory,'package-activation.json'),'utf8'));assert.equal(journal.stages.find((s:any)=>s.id===id)?.status,'running');assert.equal(journal.events.at(-1).stageId,id);calls.push(id);};
 const target:PackageReleaseTarget={id:f.target.id,async inspect(){await intent('verify');return f.target.inspect();},async stage(...args){await intent('stage');return f.target.stage(...args);},async activate(...args){await intent('activate');return f.target.activate(...args);},settle:f.target.settle.bind(f.target)};
 const state=await native(directory,f.pack,target,{async activate(){await intent('activate');},async observe(){await intent('observe');return observed(f.pack);}}).start({operationId:'intent'});assert.equal(state.status,'ready');assert.deepEqual(calls,['verify','stage','activate','activate','observe']);
});

test('unknown runtime activation blocks new operations at the target across workflow directories',async t=>{
 const f=await fixture(t);let calls=0;const broken=native(join(f.directory,'broken'),f.pack,f.target,{async activate(){calls++;throw Error('PRIVATE_SENTINEL');},async observe(){throw Error('must not observe');}});
 const state=await broken.start({operationId:'unknown-restart'});assert.equal(state.status,'incomplete');assert.equal((await f.target.inspect()).pendingOperationId,'unknown-restart');
 assert.doesNotMatch(await readFile(state.recording!.evidencePath,'utf8'),/PRIVATE_SENTINEL/);
 await assert.rejects(()=>broken.start({operationId:'unknown-restart'}),/unconfirmed/);
 const other=await native(join(f.directory,'another'),f.pack,f.target,{async activate(){calls++;},async observe(){return observed(f.pack);}}).start({operationId:'different-review'});
 assert.equal(other.status,'failed');assert.equal(calls,1);assert.equal((await f.target.inspect()).pendingOperationId,'unknown-restart');
 await assert.rejects(()=>f.target.settle(state.receipt!,{runId:'invented',digest,outcome:'ready'},{operationId:'unknown-restart',packageDigest:f.pack.manifest.digest,targetId:f.target.id}));
});

test('wrong runtime code cannot be called ready and failed observation is retained without implicit rollback',async t=>{
 const f=await fixture(t);const state=await native(join(f.directory,'attempt'),f.pack,f.target,{async activate(){},async observe(){return{...observed(f.pack),packageDigest:'b'.repeat(64)};}}).start({operationId:'wrong-runtime'});
 assert.equal(state.status,'verification-failed');assert.equal(state.recording?.complete,true);assert.equal((await f.target.inspect()).currentDigest,f.pack.manifest.digest);assert.equal(state.observation?.packageDigest,'b'.repeat(64));assert.deepEqual(await native(join(f.directory,'attempt'),f.pack,f.target,{async activate(){throw Error();},async observe(){throw Error();}}).snapshot(),state);
 const evidence=await loadEvidence(state.recording!.evidencePath);assert.equal((evidence.snapshot.sharedState.runtimeVerification as any).codeMatches,false);assert.match(backwalk(evidence,'outcome').text,/runtimeVerification/);
});

test('an explicitly incomplete runtime observation remains uncertain and cannot settle activation',async t=>{
 const f=await fixture(t);const instance=native(join(f.directory,'attempt'),f.pack,f.target,{async activate(){},async observe(){return{...observed(f.pack),evidence:{...observed(f.pack).evidence,complete:false}};}});
 const state=await instance.start({operationId:'unknown-measurement'});assert.equal(state.status,'incomplete');assert.equal(state.recording?.complete,true);assert.equal((await f.target.inspect()).pendingOperationId,'unknown-measurement');await assert.rejects(()=>instance.start({operationId:'unknown-measurement'}),/unconfirmed/);
});

test('acknowledged incomplete activation reconciles a complete negative without installation or restart',async t=>{
 const f=await fixture(t);let activations=0,stages=0,observations=0,newObservations=0;
 const target:PackageReleaseTarget={...f.target,async stage(...args){stages++;return f.target.stage(...args);}};
 const instance=new PackageActivationWorkflow({id:'install',directory:join(f.directory,'attempt'),package:f.pack,target,configurationDigest:digest,
  runtime:{async activate(){activations++;},async observe(){observations++;return{...observed(f.pack),evidence:{...observed(f.pack).evidence,complete:false}};}},
  reconciliation:{configurationDigest:'c'.repeat(64),async observe(){newObservations++;return{...observed(f.pack,false),runtimeId:'measured-inactive-units',packageDigest:null};}}});
 const initial=await instance.start({operationId:'incomplete-observation'});assert.equal(initial.status,'incomplete');
 const oldEvidence=await readFile(initial.recording!.evidencePath),oldTrace=await readFile(initial.recording!.tracePath);
 const closed=await instance.reconcile();assert.equal(closed.status,'verification-failed');assert.equal(closed.observation?.ready,false);assert.equal(closed.observation?.evidence.complete,true);assert.equal(closed.definition.configurationDigest,digest);assert.equal(closed.reconciliations?.[0]?.configurationDigest,'c'.repeat(64));
 assert.equal((await f.target.inspect()).pendingOperationId,null);assert.equal(activations,1);assert.equal(stages,1);assert.equal(observations,1);assert.equal(newObservations,1);
 assert.deepEqual(await readFile(initial.recording!.evidencePath),oldEvidence);assert.deepEqual(await readFile(initial.recording!.tracePath),oldTrace);
 const proof=packageActivationProof(closed)!;const evidence=await loadEvidence(proof.evidencePath) as any;assert.equal(evidence.kind,'package-reconciliation-settlement');assert.equal(evidence.snapshot.sharedState.settlement.acknowledged,true);assert.equal(evidence.originalEvidencePath,initial.recording!.evidencePath);assert.equal(evidence.relatedEvidence.length,2);
 assert.deepEqual(await instance.reconcile(),closed);assert.deepEqual(await instance.snapshot(),closed);assert.equal(newObservations,1);
});

test('reconciliation retains incomplete measurements then admits a fresh ready observation and its full chain',async t=>{
 const f=await fixture(t);let calls=0,activations=0;const instance=native(join(f.directory,'attempt'),f.pack,f.target,{async activate(){activations++;},async observe(){calls++;return{...observed(f.pack),runtimeId:'observed-'+calls,evidence:{...observed(f.pack).evidence,complete:calls>=3}};}});
 assert.equal((await instance.start({operationId:'one'})).status,'incomplete');const still=await instance.reconcile();assert.equal(still.status,'incomplete');assert.equal((await f.target.inspect()).pendingOperationId,'one');assert.equal(still.reconciliations?.length,1);
 const ready=await instance.reconcile();assert.equal(ready.status,'ready');assert.equal(ready.reconciliations?.length,2);assert.equal(activations,1);assert.equal(calls,3);assert.equal((await f.target.inspect()).pendingOperationId,null);assert.deepEqual(await instance.snapshot(),ready);
 const journal=join(f.directory,'attempt/package-activation.json'),changed=structuredClone(ready);changed.reconciliations![1]!.previousRecordingDigest='b'.repeat(64);await writeFile(journal,JSON.stringify(changed));await assert.rejects(()=>instance.snapshot(),/chain/);
});

test('unknown control, missing original trace and unrelated target cannot be reconciled by guessing',async t=>{
 const f=await fixture(t);let inspections=0,observations=0;const target:PackageReleaseTarget={...f.target,async inspect(){inspections++;return f.target.inspect();}};
 const unknown=native(join(f.directory,'unknown'),f.pack,target,{async activate(){throw Error('unconfirmed control');},async observe(){observations++;return observed(f.pack);}});assert.equal((await unknown.start({operationId:'unknown'})).status,'incomplete');const before=inspections;await assert.rejects(()=>unknown.reconcile(),/not-acknowledged/);assert.equal(inspections,before);assert.equal(observations,0);
 // A separate owned fixture establishes acknowledgment without altering the uncertain target above.
 const g=await fixture(t);let runtimeCalls=0;const options={id:'install',directory:join(g.directory,'ack'),package:g.pack,target:g.target,configurationDigest:digest,runtime:{async activate(){},async observe(){runtimeCalls++;return{...observed(g.pack),evidence:{...observed(g.pack).evidence,complete:false}};}}};
 const original=new PackageActivationWorkflow(options),state=await original.start({operationId:'ack'});assert.equal(state.status,'incomplete');
 const wrong=new PackageActivationWorkflow({...options,target:{...g.target,async inspect(){return{...await g.target.inspect(),currentDigest:'d'.repeat(64)};}}});const refused=await wrong.reconcile();assert.equal(refused.status,'incomplete');assert.equal(runtimeCalls,1);assert.equal((await g.target.inspect()).pendingOperationId,'ack');
 await rm(state.recording!.tracePath);await assert.rejects(()=>original.reconcile());assert.equal(runtimeCalls,1);
});

test('reconciliation settlement response loss remains blocked and no closed status can be forged from observation alone',async t=>{
 const f=await fixture(t);let observations=0;const target:PackageReleaseTarget={...f.target,async settle(){throw Error('lost settlement acknowledgment');}};
 const instance=native(join(f.directory,'attempt'),f.pack,target,{async activate(){},async observe(){observations++;return{...observed(f.pack,false),evidence:{...observed(f.pack).evidence,complete:observations>1}};}});
 assert.equal((await instance.start({operationId:'one'})).status,'incomplete');const pending=await instance.reconcile();assert.equal(pending.status,'incomplete');assert.equal((await f.target.inspect()).pendingOperationId,'one');assert.ok(pending.reconciliationIntent);await assert.rejects(()=>instance.reconcile(),/provider-proof/);assert.equal(observations,2);
 const changed=structuredClone(pending);changed.status='verification-failed';delete changed.reconciliationIntent;changed.reconciliations![0]!.status='verification-failed';await writeFile(join(f.directory,'attempt/package-activation.json'),JSON.stringify(changed));await assert.rejects(()=>instance.snapshot());
});

test('an already settled complete failure receives an exact read-only acknowledgment certificate',async t=>{
 const f=await fixture(t);let controls=0,observations=0;const instance=native(join(f.directory,'attempt'),f.pack,f.target,{async activate(){controls++;},async observe(){observations++;return observed(f.pack,false);}});
 const failed=await instance.start({operationId:'closed-failure'});assert.equal(failed.status,'verification-failed');const before=await readFile(join(f.root,'operations.json'));const original=await readFile(failed.recording!.evidencePath);
 const certified=await instance.reconcile();assert.equal(certified.status,'verification-failed');assert.equal(certified.reconciliations?.length,1);assert.equal(certified.reconciliationBase?.status,'verification-failed');assert.equal((await f.target.inspect()).pendingOperationId,null);assert.equal(controls,1);assert.equal(observations,2);
 assert.deepEqual(await readFile(join(f.root,'operations.json')),before);assert.deepEqual(await readFile(failed.recording!.evidencePath),original);assert.notEqual(packageActivationProof(certified)!.runId,failed.recording!.runId);assert.deepEqual(await instance.snapshot(),certified);assert.deepEqual(await instance.reconcile(),certified);assert.equal(observations,2);
 const changed=structuredClone(certified),proof=packageActivationProof(changed)!;const e=JSON.parse(await readFile(proof.evidencePath,'utf8'));e.status='ready';await writeFile(proof.evidencePath,JSON.stringify(e));changed.reconciliations![0]!.settlementRecording!.digest=fingerprint(e);changed.reconciliations![0]!.recording.digest=fingerprint(e);await writeFile(join(f.directory,'attempt/package-activation.json'),JSON.stringify(changed));await assert.rejects(()=>instance.snapshot(),/outcome/);
});

test('ready activation and a later same-package operation cannot be relabeled as the original failed settlement',async t=>{
 const f=await fixture(t);let failedObservations=0;const failed=native(join(f.directory,'failed'),f.pack,f.target,{async activate(){},async observe(){failedObservations++;return observed(f.pack,false);}});assert.equal((await failed.start({operationId:'old-failed'})).status,'verification-failed');
 const later=native(join(f.directory,'later'),f.pack,f.target,{async activate(){},async observe(){return observed(f.pack);}}),ready=await later.start({operationId:'later-ready'});assert.equal(ready.status,'ready');assert.deepEqual(await later.reconcile(),ready);assert.equal((await later.snapshot()).reconciliations,undefined);
 const journal=await readFile(join(f.root,'operations.json'));const refused=await failed.reconcile();assert.equal(refused.status,'incomplete');assert.deepEqual(await readFile(join(f.root,'operations.json')),journal);assert.equal(failedObservations,2);assert.equal((await f.target.inspect()).currentDigest,f.pack.manifest.digest);
});

test('a known failed ledger requires complete matching native failure proof',async t=>{
 const f=await fixture(t);await writeFile(join(f.source,'entry.mjs'),'changed');const instance=native(join(f.directory,'run'),f.pack,f.target,{async activate(){throw Error();},async observe(){throw Error();}});const state=await instance.start({operationId:'failed'});assert.equal(state.status,'failed');assert.equal(state.recording?.complete,true);
 const path=join(f.directory,'run/package-activation.json');const missing={...state};delete missing.recording;await writeFile(path,JSON.stringify(missing));await assert.rejects(()=>instance.snapshot());
 const evidence=JSON.parse(await readFile(state.recording!.evidencePath,'utf8'));evidence.status='ready';await writeFile(state.recording!.evidencePath,JSON.stringify(evidence));await writeFile(path,JSON.stringify({...state,recording:{...state.recording,digest:fingerprint(evidence)}}));await assert.rejects(()=>instance.snapshot(),/native-outcome/);
});

test('ready-to-failed state substitution and writable sealed-directory drift cannot authorize recovery',async t=>{
 const f=await fixture(t);let calls=0;const instance=native(join(f.directory,'run'),f.pack,f.target,{async activate(){calls++;},async observe(){return observed(f.pack);}});const state=await instance.start({operationId:'ready'});assert.equal(state.status,'ready');
 const journal=join(f.directory,'run/package-activation.json');await writeFile(journal,JSON.stringify({...state,status:'failed'}));await assert.rejects(()=>instance.snapshot());await writeFile(journal,JSON.stringify(state));
 for(const relative of ['releases','releases/'+f.pack.manifest.digest,'releases/'+f.pack.manifest.digest+'/nested']){
  const path=join(f.root,relative),before=(await lstat(path)).mode&0o777;await chmod(path,0o777);await assert.rejects(()=>f.target.inspect());
  const failed=await native(join(f.directory,'drift-'+relative.replaceAll('/','-')),f.pack,f.target,{async activate(){calls++;},async observe(){return observed(f.pack);}}).start({operationId:'drift'});assert.equal(failed.status,'failed');assert.equal(calls,1);await chmod(path,before);
 }
});

test('mid-copy transport corruption cleans only its own staging directory and leaves prior release/data intact',async t=>{
 const f=await fixture(t);const first=await native(join(f.directory,'first'),f.pack,f.target,{async activate(){},async observe(){return observed(f.pack);}}).start({operationId:'good'});assert.equal(first.status,'ready');
 await writeFile(join(f.source,'entry.mjs'),'console.log("v2");');const pack=await buildDirectoryPackage({id:'app',directory:f.source,paths:['entry.mjs','nested/data.txt']});
 const target=createFileReleaseTarget({id:'app-host',directory:f.root,runner:async request=>{const input=JSON.parse(request.input);if(input.operation==='stage')input.files[1].content=Buffer.from('wrong').toString('base64');return runHostProcess({...request,input:JSON.stringify(input)});}});
 const state=await native(join(f.directory,'failed-stage'),pack,target,{async activate(){throw Error('must not activate');},async observe(){throw Error();}}).start({operationId:'bad-copy'});
 assert.equal(state.status,'failed');assert.equal((await f.target.inspect()).currentDigest,f.pack.manifest.digest);assert.deepEqual(await readdir(join(f.root,'releases')),[f.pack.manifest.digest]);
});

test('target ownership and runtime traversal policy are pinned while journals stay private',async t=>{
 const f=await fixture(t);const target=createFileReleaseTarget({id:'app-host',directory:f.root,allowRuntimeTraversal:true});const state=await native(join(f.directory,'run'),f.pack,target,{async activate(){},async observe(){return observed(f.pack);}}).start({operationId:'public-code'});assert.equal(state.status,'ready');
 assert.equal((await lstat(f.root)).mode&0o777,0o711);assert.equal((await lstat(join(f.root,'releases'))).mode&0o777,0o711);assert.equal((await lstat(join(f.root,'operations.json'))).mode&0o777,0o600);
 await assert.rejects(()=>f.target.inspect());await assert.rejects(()=>createFileReleaseTarget({id:'unrelated',directory:f.root,allowRuntimeTraversal:true}).inspect());
});

test('explicit runtime traversal survives a hardened host umask and permission-policy drift is refused',async t=>{
 const f=await fixture(t);const target=createFileReleaseTarget({id:'app-host',directory:f.root,allowRuntimeTraversal:true,runner:request=>runHostProcess({...request,args:['-c','import os;os.umask(0o077)\n'+request.args.at(-1)]})});
 const state=await native(join(f.directory,'run'),f.pack,target,{async activate(){},async observe(){return observed(f.pack);}}).start({operationId:'private-umask'});assert.equal(state.status,'ready');
 assert.equal((await lstat(f.root)).mode&0o777,0o711);assert.equal((await lstat(join(f.root,'releases'))).mode&0o777,0o711);assert.equal((await lstat(join(f.root,'owner.json'))).mode&0o777,0o600);
 await chmod(f.root,0o700);await assert.rejects(()=>target.inspect());
});

test('Linux non-root runtime can traverse an opted-in package but cannot read activation journals',{skip:process.platform!=='linux'||process.getuid?.()!==0?'requires Linux root to switch to an actual unprivileged UID':false},async t=>{
 const f=await fixture(t);await chmod(f.directory,0o755);const target=createFileReleaseTarget({id:'app-host',directory:f.root,allowRuntimeTraversal:true});const state=await native(join(f.directory,'run'),f.pack,target,{async activate(){},async observe(){return observed(f.pack);}}).start({operationId:'non-root'});assert.equal(state.status,'ready');
 const code='import os,pathlib,sys\nos.setgroups([]);os.setgid(65534);os.setuid(65534)\nassert pathlib.Path(sys.argv[1]).read_text()==\'console.log("v1");\\n\'\ntry:pathlib.Path(sys.argv[2]).read_text()\nexcept PermissionError:pass\nelse:raise AssertionError("private journal readable")\n';
 const result=spawnSync('python3',['-c',code,join(f.root,'current/entry.mjs'),join(f.root,'operations.json')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});

test('missing trace or changed native progress prevents retained ready admission',async t=>{
 const f=await fixture(t);const instance=native(join(f.directory,'run'),f.pack,f.target,{async activate(){},async observe(){return observed(f.pack);}});const state=await instance.start({operationId:'trace'});assert.equal(state.status,'ready');
 const journal=join(f.directory,'run/package-activation.json');const value=JSON.parse(await readFile(journal,'utf8'));value.events[0].timestamp++;await writeFile(journal,JSON.stringify(value));await assert.rejects(()=>instance.snapshot(),/native-capture-progress/);
 await writeFile(journal,JSON.stringify(state));await rm(state.recording!.tracePath);await assert.rejects(()=>instance.snapshot());
});

test('target source and target directory substitution are refused before unrelated writes',async t=>{
 const f=await fixture(t);const unowned=join(f.directory,'unowned');await mkdir(unowned);await writeFile(join(unowned,'user-data'),'untouched');const target=createFileReleaseTarget({id:'app-host',directory:unowned});
 const state=await native(join(f.directory,'run'),f.pack,target,{async activate(){throw Error();},async observe(){throw Error();}}).start({operationId:'unowned'});assert.equal(state.status,'failed');assert.equal(await readFile(join(unowned,'user-data'),'utf8'),'untouched');
 const m=structuredClone(f.pack.manifest);(m.files[0] as {path:string}).path='../escaped';m.digest=fingerprint({...m,digest:undefined});assert.throws(()=>readDirectoryPackageManifest(m));
});

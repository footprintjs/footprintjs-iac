import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { createAdapterFlowChart } from '../src/adapter-flow/create-chart.ts';
import { createDeploymentRecorder } from '../src/progress/recorder.ts';
import { fingerprint } from '../src/util.ts';
import type { ResourceAdapter, Stack } from '../src/types.ts';
import type { NativeDeploymentRecording } from '../src/progress/chart.ts';
function nativeEvents(recording: NativeDeploymentRecording): any[] { return (recording.snapshot.recorders as any[]).find(row => row.id === 'iac-native-stage-progress')?.data.events ?? []; }
test('an actual held native adapter stage streams start before completion without scope payloads or invented end events', { timeout: 10000 }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'iac-live-native-')); t.after(() => rm(directory, { recursive: true, force: true }));
 let release!: () => void, entered!: () => void, exists = false, effects = 0;
 const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
 const recorder = createDeploymentRecorder({captureStages:true}), frames: NativeDeploymentRecording[] = []; recorder.subscribeRecording(recording => frames.push(recording));
 const stack: Stack = { name: 'live-native', resources: [{ id: 'app', provider: 'native', spec: { secret: 'PRIVATE_CONFIGURATION' } }] };
 const adapter: ResourceAdapter = { name: 'native', async observe(resource) { return { exists, owned: true, ...(exists ? { fingerprint: fingerprint(resource.spec), ready: true } : {}) }; },
  async apply() { throw Error('Opaque callback must not run'); }, async remove() {}, async waitReady() {},
  createApplyFlow(_resource, _context, binding) { return createAdapterFlowChart(binding, [{ id: 'held-native-effect', name: 'Held native effect', phase: 'apply', async run(scope) {
   effects++; scope.setValue('PRIVATE_SCOPE_KEY', 'PRIVATE_TEMPORARY_VALUE'); entered(); await held; exists = true;
  } }]); } };
 const engine = new InfraEngine({ adapters: [adapter], store: new FileStateStore(join(directory, 'state')), recorders: [recorder], chartObservers: [recorder], traceDirectory: join(directory, 'trace') });
 const pending = engine.apply(stack); await started;
 const live = frames.at(-1)!; assert(live); const events = nativeEvents(live), start = events.find(row => row.type === 'start' && /\/held-native-effect#\d+$/.test(row.runtimeStageId));
 assert(start, 'real nested native stage is visible while its provider call is held');
 assert(!events.some(row => row.type === 'end' && row.runtimeStageId === start.runtimeStageId), 'unfinished stage has no fabricated completion');
 assert(!JSON.stringify(frames).includes('PRIVATE_'), 'live publications omit configuration, scope values and private names');
 release(); const result = await pending; assert.equal(result.ok, true); assert.equal(effects, 1);
 const final = recorder.getRecording()!; assert(nativeEvents(final).some(row => row.type === 'end' && row.runtimeStageId === start.runtimeStageId)); assert.equal(final.provenance.runId, result.runId);
 const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8')), retained = evidence.snapshot.recorders.find((row: any) => row.id === 'iac-native-stage-progress').data;
 assert.equal(retained.runId, evidence.snapshot.runId); assert.equal(retained.droppedEvents, 0); assert.equal(retained.observerFailures, 0);
 assert(retained.events.some((row: any) => row.type === 'decision' && row.chosen === 'held-native-effect'));
 const before = frames.length; assert.equal((await engine.apply(stack)).ok, true); assert.equal(effects, 1); assert(frames.length > before);
 assert(!nativeEvents(recorder.getRecording()!).some(row => /\/held-native-effect#\d+$/.test(row.runtimeStageId)), 'new no-op recording does not borrow old effect stages');
});
test('a failed live recording subscriber cannot change the real native effect or the deployment result', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'iac-live-observer-')); t.after(() => rm(directory, { recursive: true, force: true })); let effects = 0, exists = false;
 const adapter: ResourceAdapter = { name: 'native', async observe(resource) { return { exists, owned: true, ...(exists ? { fingerprint: fingerprint(resource.spec), ready: true } : {}) }; }, async apply() {}, async remove() {}, async waitReady() {},
  createApplyFlow(_resource, _context, binding) { return createAdapterFlowChart(binding, [{ id: 'effect', name: 'Effect', phase: 'apply', async run() { effects++; exists = true; } }]); } };
 const recorder = createDeploymentRecorder(); const result = await new InfraEngine({ adapters: [adapter], store: new FileStateStore(join(directory, 'state')), recorders: [recorder],
  chartObservers: [{ id: 'unavailable-viewer', onChart() {}, onRecording() { throw Error('PRIVATE_VIEWER_EXCEPTION'); } }], traceDirectory: join(directory, 'trace') })
  .apply({ name: 'observer-isolation', resources: [{ id: 'app', provider: 'native', spec: {} }] });
 assert.equal(result.ok, true); assert.equal(effects, 1); const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
 assert(evidence.snapshot.recorders.find((row: any) => row.id === 'iac-native-stage-progress').data.observerFailures > 0); assert(!JSON.stringify(evidence).includes('PRIVATE_VIEWER_EXCEPTION'));
});

test('native selector observations retain exact selected branch IDs including an unselected branch', async()=>{
 const {flowChart,FlowChartExecutor,select}=await import('footprintjs');
 const {liveRecording}=await import('../src/execution/live-recording.ts');
 const native=flowChart('Read selection',(scope:Record<string,any>)=>{scope.allowed=true;},'read')
  .addSelectorFunction('Select observations',(scope:Record<string,any>)=>select(scope,[{when:{allowed:{eq:true}},then:'chosen'},{when:{allowed:{eq:false}},then:'unused'}]),'select')
  .addFunctionBranch('chosen','Observe selected service',()=>undefined)
  .addFunctionBranch('unused','Do not observe this service',()=>assert.fail('Unselected branch ran')).end().build();
 const executor=new FlowChartExecutor(native),frames:NativeDeploymentRecording[]=[];
 const live=liveRecording({version:1,runId:'selector-deployment',stack:'selector',structure:native.buildTimeStructure,resources:[]},[{id:'viewer',onChart(){},onRecording(recording){frames.push(recording);}}],()=>executor.getSnapshot())!;
 executor.attachCombinedRecorder(live.recorder);await executor.run();live.flush();live.close();
 const events=nativeEvents(frames.at(-1)!);assert.deepEqual(events.find(row=>row.type==='decision'&&row.stageId==='select')?.chosen,['chosen']);
 assert(!events.some(row=>row.type==='start'&&row.stageId==='unused'));
});

test('ordinary resource recording stays stage-capture free until the caller explicitly opts in',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'iac-live-optin-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let installed:unknown,effects=0;
 const adapter:ResourceAdapter={name:'native',async observe(){return installed===undefined?{exists:false}:{exists:true,owned:true,ready:true,fingerprint:fingerprint(installed)};},async apply(){throw Error('opaque');},async remove(){},async waitReady(){},
  createApplyFlow(resource,_context,binding){return createAdapterFlowChart(binding,[{id:'effect',name:'Effect',phase:'apply',async run(){installed=resource.spec;effects++;}}]);}};
 const store=new FileStateStore(join(directory,'state'));
 for(const captureStages of [false,true]){
  const recorder=createDeploymentRecorder({captureStages}),frames:NativeDeploymentRecording[]=[];recorder.subscribeRecording(frame=>frames.push(frame));
  const result=await new InfraEngine({adapters:[adapter],store,recorders:[recorder],chartObservers:[recorder],traceDirectory:join(directory,'trace')})
   .apply({name:'capture-optin',resources:[{id:'app',provider:'native',spec:{version:captureStages?2:1}}]});
  assert.equal(result.ok,true);const evidence=JSON.parse(await readFile(result.evidencePath,'utf8'));
  assert.equal(evidence.snapshot.recorders.some((row:any)=>row.id==='iac-native-stage-progress'),captureStages,'native-stage work is not attached by a default recorder');
  assert.equal(frames.length>0,captureStages);assert.equal(recorder.getRecording()!==undefined,captureStages);
 }
 assert.equal(effects,2,'the observer option never changes which actual provider effects execute');
});

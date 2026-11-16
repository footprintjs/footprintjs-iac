import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowChartExecutor } from 'footprintjs';
import type { RecordSink } from 'foottrace/write';
import { InfraEngine } from '../src/engine.ts';
import { FileStateStore } from '../src/store.ts';
import { ReconcileStrategy } from '../src/strategies.ts';
import { ExecutionPersistence } from '../src/execution/persistence.ts';
import { createOperationExecutor } from '../src/execution/execute-operation.ts';
import { createApplyChart } from '../src/execution/create-apply-chart.ts';
import { createAdapterFlowChart } from '../src/adapter-flow/create-chart.ts';
import type { ResourceAdapter, Stack } from '../src/types.ts';

for(const failureStage of ['native-intent','effect'])test(`native capture loss at ${failureStage} retains intent and never retries unknown work`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'iac-native-sink-loss-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const stack:Stack={name:'capture-loss',resources:[{id:'app',provider:'native',spec:{x:1}}]},store=new FileStateStore(join(directory,'state'));
  let effects=0;
  const adapter:ResourceAdapter={name:'native',supportsSafeRetry:true,async observe(){return{exists:false};},async apply(){},async remove(){},async waitReady(){},
    createApplyFlow(_resource,_context,binding){return createAdapterFlowChart(binding,[{id:'effect',name:'Provider effect',phase:'apply',async run(){effects++;}}]);}};
  const plan=await new InfraEngine({adapters:[adapter],store}).plan(stack),state=await store.load(stack.name),results:Record<string,unknown>={};
  const execute=createOperationExecutor({adapters:new Map([[adapter.name,adapter]]),state,runId:'deployment',strategy:new ReconcileStrategy(),persistence:new ExecutionPersistence(store)});
  const chart=createApplyChart(plan,execute,results,1,'deployment');
  let lost=0;const sink:RecordSink={opened(){},note(){},closed(){},commit(entry){if(entry.bundle.stageId.endsWith(`/${failureStage}`)){lost++;throw Error('capture-unavailable');}}};
  const executor=new FlowChartExecutor(chart.chart,{sink:{adapter:sink,onFailure:'fail',flush:'auto'}});
  await assert.rejects(()=>executor.run());assert.equal(lost,1);assert.equal(effects,failureStage==='effect'?1:0);
  assert.ok((await store.load(stack.name)).resources.app?.pending,'durable intent is retained across a lost native entry');
  assert.equal(results.app,undefined,'capture loss cannot publish an application Ready result');
  assert.equal(executor.getSnapshot().sink?.failed,1);
});

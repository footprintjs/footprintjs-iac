import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function loaded(relative:string):string[]{
  const url=new URL(relative,import.meta.url).href;
  const script=`import{registerHooks}from'node:module';const files=[];registerHooks({load(url,context,next){files.push(url);return next(url,context)}});await import(${JSON.stringify(url)});process.stdout.write(JSON.stringify(files.filter(url=>url.includes('/footprint-iac/src/'))));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('provider-free core does not load provider or host transport modules',()=>{
  const files=loaded('../src/core.ts');assert.ok(files.some(file=>file.endsWith('/engine.ts')));
  assert.ok(files.every(file=>!file.includes('/providers/')&&!file.includes('/platform-access/')&&!file.includes('/platform-kubernetes/')&&!file.includes('/deployment-strategy/host')));
});
test('selecting systemd or Kubernetes loads only the selected provider implementation',()=>{
  const systemd=loaded('../src/deployment-strategy/systemd.ts');assert.ok(systemd.some(file=>file.endsWith('/host.ts')));
  assert.ok(systemd.every(file=>!file.includes('/providers/kubernetes')&&!file.includes('/kubernetes-workload/')&&!file.includes('/platform-kubernetes/')));
  const kubernetes=loaded('../src/deployment-strategy/kubernetes.ts');assert.ok(kubernetes.some(file=>file.endsWith('/providers/kubernetes.ts')));
  assert.ok(kubernetes.every(file=>!file.includes('/deployment-strategy/host')&&!file.includes('/deployment-strategy/systemd')));
});

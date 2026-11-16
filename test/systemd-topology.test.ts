import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSystemdTopology } from '../src/deployment-strategy/topology.ts';
import { compileSystemdDeployment } from '../src/deployment-strategy/compile.ts';
import { projectSystemTopology } from '../src/system-topology/index.ts';

const hash='a'.repeat(64);
const input=()=>({id:'generic-services',label:'Registered services',targetId:'registered-server',hostLabel:'Application server',stack:'services',releaseDigest:hash,
  units:[{id:'api',name:'actual-api.service',fragmentPath:'/etc/systemd/system/actual-api.service',configurationDigest:hash},
    {id:'tools',name:'actual-tools.service',fragmentPath:'/etc/systemd/system/actual-tools.service',configurationDigest:hash,dependsOn:['api']}]});

test('systemd topology is a pure existing-unit declaration bound to the unchanged group graph',()=>{
  const options=input(),graph=compileSystemdDeployment(options),definition=defineSystemdTopology(options);
  assert.equal(definition.binding.targetId,options.targetId);assert.equal(definition.binding.graphDigest,graph.digest);assert.equal(graph.resources.length,1);
  const host=definition.boundaries.find(boundary=>boundary.kind==='host')!,runtime=definition.boundaries.find(boundary=>boundary.kind==='runtime')!;
  assert.equal(host.label,'Application server');assert.equal(runtime.parentId,host.id);assert.deepEqual(runtime.technology,{id:'systemd',label:'systemd'});
  for(const boundary of [host,runtime])assert.deepEqual(boundary.bindings,{resourceIds:['systemd-services'],componentIds:['api','tools']});
  assert.deepEqual(definition.nodes.map(node=>({id:node.id,label:node.label,category:node.category,origin:node.origin,technology:node.technology,bindings:node.bindings})),[
    {id:'api',label:'actual-api.service',category:'compute',origin:'existing',technology:undefined,bindings:{resourceIds:['systemd-services'],componentIds:['api']}},
    {id:'tools',label:'actual-tools.service',category:'compute',origin:'existing',technology:undefined,bindings:{resourceIds:['systemd-services'],componentIds:['tools']}},
  ]);
  assert.equal(definition.connections.length,0);assert.deepEqual(compileSystemdDeployment(options),graph,'declaration cannot alter resource identity or deployment order');
  const view=projectSystemTopology(definition,{...definition.binding,definitionDigest:definition.digest,configurationDigest:hash,resources:[],components:[],checks:[]});
  assert.ok(view.nodes.every(node=>node.status==='pending'));assert.ok(view.boundaries.every(boundary=>!boundary.observed));
  options.units[0]!.name='changed.service';assert.equal(definition.nodes[0]!.label,'actual-api.service');assert.ok(Object.isFrozen(definition.nodes));
});

test('independent systemd resources retain exact unit bindings and collision-safe boundaries',()=>{
  const options=input();options.units[0]!.id='registered-host';options.units[1]!.dependsOn=['registered-host'];
  const definition=defineSystemdTopology({...options,transaction:'independent'}),graph=compileSystemdDeployment({...options,transaction:'independent'});
  assert.equal(definition.binding.graphDigest,graph.digest);assert.deepEqual(definition.nodes.map(node=>node.bindings.resourceIds),[['registered-host'],['tools']]);
  assert.ok(definition.boundaries.every(boundary=>!definition.nodes.some(node=>node.id===boundary.id)));
  assert.ok(definition.boundaries.every(boundary=>boundary.bindings?.resourceIds.length===2&&boundary.bindings.componentIds?.length===2));
});

test('systemd topology rejects malformed/private inputs without invoking accessors or a host port',()=>{
  let calls=0;const accessor=Object.defineProperty(input(),'host',{enumerable:true,get(){calls++;throw Error('must not invoke');}});
  assert.throws(()=>defineSystemdTopology(accessor));assert.equal(calls,0);
  assert.throws(()=>defineSystemdTopology({...input(),host:{inspect(){calls++;}}} as never));assert.equal(calls,0);
  assert.throws(()=>defineSystemdTopology({...input(),targetId:''}));assert.throws(()=>defineSystemdTopology({...input(),units:[{...input().units[0]!,configurationDigest:'invalid'}]}));
});

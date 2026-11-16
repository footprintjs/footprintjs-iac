import { jsonCopy } from '../graph/data.ts';
import { defineSystemTopology } from '../system-topology/node.ts';
import { compileSystemdDeployment } from './compile.ts';
import { readSystemdUnits } from './data.ts';
import type { SystemdDeploymentOptions } from './types.ts';

export interface SystemdTopologyInput extends Pick<SystemdDeploymentOptions,'stack'|'releaseDigest'|'units'|'transaction'> {
  id:string;label:string;targetId:string;hostLabel?:string;
}

/** Pure default placement from registered systemd facts. It makes no claim about unit internals or communication. */
export function defineSystemdTopology(input:SystemdTopologyInput){
  const value=jsonCopy(input) as unknown as SystemdTopologyInput;
  if(Object.keys(value).some(key=>!['id','label','targetId','hostLabel','stack','releaseDigest','units','transaction'].includes(key)))throw Error('systemd-topology-unknown-field');
  const units=readSystemdUnits(value.units),graph=compileSystemdDeployment({stack:value.stack,releaseDigest:value.releaseDigest,units,
    ...(value.transaction===undefined?{}:{transaction:value.transaction})});
  const taken=new Set(units.map(unit=>unit.id));
  const boundaryId=(base:string)=>{let id=base,index=0;while(taken.has(id))id=`${base}-${++index}`;taken.add(id);return id;};
  const host=boundaryId('registered-host'),runtime=boundaryId('systemd-runtime');
  const bindings={resourceIds:graph.resources.map(resource=>resource.id),componentIds:units.map(unit=>unit.id)};
  return defineSystemTopology({id:value.id,label:value.label,
    boundaries:[
      {id:host,label:value.hostLabel??value.targetId,kind:'host',bindings},
      {id:runtime,label:'systemd',kind:'runtime',parentId:host,technology:{id:'systemd',label:'systemd'},bindings},
    ],
    nodes:units.map(unit=>({id:unit.id,label:unit.name,category:'compute',origin:'existing',boundaryId:runtime,
      bindings:{resourceIds:[value.transaction==='independent'?unit.id:'systemd-services'],componentIds:[unit.id]}})),
    connections:[],
  },{targetId:value.targetId,graphDigest:graph.digest});
}

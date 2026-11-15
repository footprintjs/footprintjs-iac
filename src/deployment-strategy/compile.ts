import { identifier } from '../graph/data.ts';
import { compileGraph } from '../graph/compile.ts';
import { readSystemdUnits, sha } from './data.ts';
import type { SystemdDeploymentOptions } from './types.ts';

/** Pure construction of the provider group/independent execution graph. */
export function compileSystemdDeployment(input: Pick<SystemdDeploymentOptions,'stack'|'units'|'releaseDigest'|'transaction'>) {
  const units = readSystemdUnits(input.units); sha(input.releaseDigest); identifier(input.stack,'systemd stack');
  if(input.transaction!==undefined&&!['group','independent'].includes(input.transaction))throw Error('systemd-transaction-not-admitted');
  const resources=input.transaction==='independent'?units.map(unit=>({id:unit.id,provider:'systemd',dependsOn:[...(unit.dependsOn??[])],spec:{kind:'SystemdService',name:unit.name,configurationDigest:unit.configurationDigest,releaseDigest:input.releaseDigest}})):
    [{id:'systemd-services',provider:'systemd',dependsOn:[],spec:{kind:'SystemdServiceGroup',units:units.map(({id,name,configurationDigest})=>({id,name,configurationDigest})),releaseDigest:input.releaseDigest}}];
  return compileGraph({name:input.stack,resources:resources as import('../types.ts').Resource[],boundaries:[],memberships:[],relations:[]});
}

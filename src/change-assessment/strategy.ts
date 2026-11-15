import {fingerprint} from '../util.ts';
import type {ChangeAssessmentStrategy,ChangeDisposition,ChangeProbe,ResourceChange} from './types.ts';

/** Conservative default; new strategies still pass the common ownership/capability admission below. */
export function conservativeChangeStrategy(id='conservative'):ChangeAssessmentStrategy{
  return{id,label:'Provider capability assessment',classify(change,probe){
    if(probe.observation.exists&&probe.observation.owned!==true)return{disposition:'blocked',reasons:['resource-not-owned']};
    if(!change.desired)return{disposition:!probe.observation.exists?'noop':change.previous?.lifecycle?.retainOnRemoval?'blocked':'delete',reasons:[!probe.observation.exists?'resource-already-absent':change.previous?.lifecycle?.retainOnRemoval?'retention-required':'explicit-removal-required']};
    if(!probe.observation.exists){
      if(probe.update==='rejected'||probe.update==='unknown')return{disposition:probe.update==='rejected'?'blocked':'unknown',reasons:probe.reasons};
      return{disposition:change.previous&&change.data!=='stateless'?'unknown':'create',reasons:[change.previous&&change.data!=='stateless'?'stateful-source-missing':'resource-absent']};
    }
    if(probe.observation.fingerprint===fingerprint(change.desired.spec)&&(!change.previous||sameIdentity(change)))return{disposition:probe.observation.ready===false?'verify':'noop',reasons:['desired-state-present']};
    return{disposition:({supported:'update','replacement-required':'replace',rejected:'blocked',unknown:'unknown','not-needed':'unknown'} as const)[probe.update],reasons:probe.reasons};
  }};
}
function sameIdentity(change:ResourceChange):boolean{return !!change.desired&&!!change.previous&&change.desired.id===change.previous.id&&change.desired.provider===change.previous.provider;}
/** Strategies cannot turn unknown provider facts or foreign resources into an executable decision. */
export function admitChangeDisposition(change:ResourceChange,probe:ChangeProbe,wanted:ChangeDisposition):{disposition:ChangeDisposition;reasons:string[]}{
  if(probe.observation.exists&&probe.observation.owned!==true)return{disposition:'blocked',reasons:['resource-not-owned']};
  if(probe.destination?.exists&&(!probe.destination.physicalId||!probe.observation.physicalId||probe.destination.physicalId!==probe.observation.physicalId))return{disposition:'blocked',reasons:['replacement-destination-exists']};
  if(wanted==='create'&&(probe.observation.exists||!change.desired))return{disposition:'blocked',reasons:['create-not-established']};
  if(wanted==='create'&&(probe.update==='rejected'||probe.update==='unknown'||change.previous&&change.data!=='stateless'))return{
    disposition:probe.update==='rejected'?'blocked':'unknown',reasons:[change.previous&&change.data!=='stateless'?'stateful-source-missing':'create-capability-not-established']};
  if(wanted==='update'&&(!probe.observation.exists||probe.update!=='supported'||!change.desired))return{disposition:'unknown',reasons:['update-not-established']};
  if(wanted==='replace'&&(!probe.observation.exists||probe.update!=='replacement-required'||!change.previous||!change.desired))return{disposition:'unknown',reasons:['replacement-not-established']};
  if((wanted==='noop'||wanted==='verify')&&!(wanted==='noop'&&!change.desired&&!probe.observation.exists)&&(!change.desired||!probe.observation.exists||probe.observation.fingerprint!==fingerprint(change.desired.spec)))return{disposition:'unknown',reasons:['convergence-not-established']};
  if((wanted==='noop'||wanted==='verify')&&change.previous&&change.desired&&!sameIdentity(change))return{disposition:'blocked',reasons:['logical-resource-identity-changed']};
  if(wanted==='delete'&&(!change.previous||change.desired||change.previous.lifecycle?.retainOnRemoval))return{disposition:'blocked',reasons:['deletion-not-established']};
  return{disposition:wanted,reasons:[]};
}

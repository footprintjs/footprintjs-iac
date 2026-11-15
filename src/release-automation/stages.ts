import {ScopeFacade,type ScopeFactory} from 'footprintjs/advanced';
import type {ReleaseCatalog} from '../releases/types.ts';
import {readReleaseChoice,readResolvedReleaseChoice} from '../releases/data.ts';
import {canonical,fingerprint} from '../util.ts';
import {projectReleaseAutomationAttempt} from './project.ts';
import {releaseSourceDigest} from './source.ts';
import type {ReleaseAutomationAttempt,ReleaseAutomationState} from './types.ts';

export class AutomationScope extends ScopeFacade{}
export const automationScopeFactory:ScopeFactory<AutomationScope>=(context,name,readOnly,environment)=>new AutomationScope(context,name,readOnly,environment);
export interface AutomationStages {
  state:ReleaseAutomationState;catalog:ReleaseCatalog;attempt?:ReleaseAutomationAttempt;
  persist():Promise<void>;prepare():Promise<void>;launch():Promise<void>;
}
export function initializeAutomation(config:AutomationStages){return(scope:AutomationScope)=>{
  const d=config.state.definition;scope.setValue('definition',{id:d.id,catalogId:d.catalogId,adapterId:d.adapterId,configurationDigest:d.configurationDigest,automatic:d.automatic});scope.setValue('definitionDigest',config.state.definitionDigest);
  if(config.attempt)scope.setValue('request',{attemptId:config.attempt.id,releaseId:config.attempt.releaseId,trigger:config.attempt.trigger});
};}
function bind(scope:AutomationScope,config:AutomationStages){if(scope.getValue('definitionDigest')!==config.state.definitionDigest)throw Error('Native automation binding changed');}
export function discoverReleases(config:AutomationStages){return async(scope:AutomationScope)=>{
  bind(scope,config);scope.getValue('definition');
  try{const rows=await config.catalog.list();if(!Array.isArray(rows)||rows.length>1000)throw Error('Bound release catalog');const choices=rows.map(readReleaseChoice);if(new Set(choices.map(choice=>choice.id)).size!==choices.length)throw Error('Duplicate source choice');
    config.state.choices=choices;config.state.discoveryStatus='available';
    scope.setValue('discovery',{status:'available',choices});
  }catch{config.state.discoveryStatus='unavailable';scope.setValue('discovery',{status:'unavailable',choices:[]});}
  await config.persist();
};}
export function resolveRelease(config:AutomationStages){return async(scope:AutomationScope)=>{
  bind(scope,config);const request=scope.getValue('request') as {releaseId:string};const attempt=config.attempt!;attempt.status='resolving';await config.persist();
  try{const choice=config.state.choices.find(choice=>choice.id===request.releaseId);if(!choice)throw Error('Choose discovered release');
    const resolved=readResolvedReleaseChoice(await config.catalog.resolve(request.releaseId));
    if(resolved.id!==choice.id||resolved.source.repository!==choice.source.repository||resolved.source.ref!==choice.source.ref
      ||choice.source.commit&&resolved.source.commit!==choice.source.commit||choice.source.tree&&resolved.source.tree!==choice.source.tree)throw Error('Source choice changed');
    attempt.source=resolved;attempt.sourceDigest=releaseSourceDigest(resolved.source);
    const duplicate=config.state.attempts.find(other=>other.id!==attempt.id&&other.sourceDigest===attempt.sourceDigest);
    if(duplicate){attempt.status='skipped';attempt.reason='source-already-attempted';attempt.duplicateOf=duplicate.id;}
    scope.setValue('source',{choice:resolved,sourceDigest:attempt.sourceDigest,status:attempt.status});
  }catch{attempt.status='failed';attempt.reason='source-resolution-unconfirmed';scope.setValue('source',{status:'unconfirmed'});}
  await config.persist();
};}
export function prepareRelease(config:AutomationStages){return async(scope:AutomationScope)=>{
  bind(scope,config);const source=scope.getValue('source') as {sourceDigest?:string};const attempt=config.attempt!;
  if(attempt.status==='resolving'&&source.sourceDigest===attempt.sourceDigest){attempt.status='preparing';await config.persist();await config.prepare();}
  scope.setValue('prepared',projectReleaseAutomationAttempt(attempt));await config.persist();
};}
export function launchRelease(config:AutomationStages){return async(scope:AutomationScope)=>{
  bind(scope,config);const prepared=scope.getValue('prepared') as {preparation?:{releaseDigest?:string}};const attempt=config.attempt!;
  if(attempt.status==='preparing'&&attempt.preparation?.status==='passed'&&prepared.preparation?.releaseDigest===attempt.preparation.release?.digest){attempt.status='deploying';await config.persist();await config.launch();}
  scope.setValue('outcome',projectReleaseAutomationAttempt(attempt));await config.persist();
};}
export function sealAutomation(config:AutomationStages){return(scope:AutomationScope)=>{
  bind(scope,config);const outcome=scope.getValue('outcome');if(canonical(outcome)!==canonical(projectReleaseAutomationAttempt(config.attempt!)))throw Error('Automation outcome differs from native facts');
};}

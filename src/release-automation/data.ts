import {identifier,jsonCopy} from '../graph/data.ts';
import {readReleaseChoice,readResolvedReleaseChoice,releaseDigest,releaseObject,releaseText} from '../releases/data.ts';
import {readReleasePreparationState} from '../releases/preparation-data.ts';
import {readPipelineState} from '../pipeline/data.ts';
import type {ReleaseAutomationDefinition,ReleaseAutomationState,ReleaseAutomationAttempt,ReleaseAutomationRecording} from './types.ts';

export function readReleaseAutomationDefinition(input:unknown):ReleaseAutomationDefinition {
  const row=releaseObject(input,['version','id','label','catalogId','adapterId','configurationDigest','automatic']);
  const automatic=releaseObject(row.automatic,['enabled','initial']);
  if(row.version!==1||typeof automatic.enabled!=='boolean'||!['observe','latest'].includes(String(automatic.initial)))throw Error('Configure explicit release automation policy');
  return{version:1,id:identifier(row.id,'release automation'),label:releaseText(row.label,160),catalogId:identifier(row.catalogId,'release catalog'),adapterId:identifier(row.adapterId,'automation adapter'),configurationDigest:releaseDigest(row.configurationDigest),automatic:{enabled:automatic.enabled,initial:automatic.initial as 'observe'|'latest'}};
}
function list(value:unknown,max=256):unknown[]{if(!Array.isArray(value)||value.length>max)throw Error('Release automation history exceeds limits');return value;}
function time(value:unknown):number{if(!Number.isSafeInteger(value)||(value as number)<0)throw Error('Invalid automation time');return value as number;}
function recording(input:unknown):ReleaseAutomationRecording {
  const row=releaseObject(input,['runId','evidencePath','tracePath','complete','attemptId']);if(typeof row.complete!=='boolean')throw Error('Invalid automation capture');
  return{runId:releaseText(row.runId,256),evidencePath:releaseText(row.evidencePath,4096),tracePath:releaseText(row.tracePath,4096),complete:row.complete,...(row.attemptId!==undefined?{attemptId:identifier(row.attemptId,'automation attempt')}:{})};
}
function attempt(input:unknown):ReleaseAutomationAttempt {
  const row=releaseObject(input,['id','releaseId','trigger','status','createdAt','source','sourceDigest','duplicateOf','preparation','pipeline','recordings','reason']);
  if(!['manual','automatic'].includes(String(row.trigger))||!['reserved','resolving','preparing','deploying','waiting','passed','failed','incomplete','skipped'].includes(String(row.status)))throw Error('Invalid release automation attempt');
  const value:ReleaseAutomationAttempt={id:identifier(row.id,'automation attempt'),releaseId:identifier(row.releaseId,'release choice'),trigger:row.trigger as ReleaseAutomationAttempt['trigger'],status:row.status as ReleaseAutomationAttempt['status'],createdAt:time(row.createdAt),recordings:list(row.recordings,32).map(recording)};
  if(row.source!==undefined){value.source=readResolvedReleaseChoice(row.source);if(value.source.id!==value.releaseId)throw Error('Resolved release identity changed');}
  if(row.sourceDigest!==undefined)value.sourceDigest=releaseDigest(row.sourceDigest);
  if(row.duplicateOf!==undefined)value.duplicateOf=identifier(row.duplicateOf,'duplicate release attempt');
  if(row.preparation!==undefined)value.preparation=readReleasePreparationState(row.preparation);
  if(row.pipeline!==undefined)value.pipeline=readPipelineState(row.pipeline);
  if(row.reason!==undefined)value.reason=identifier(row.reason,'automation reason');
  return value;
}
export function readReleaseAutomationState(input:unknown):ReleaseAutomationState {
  const row=releaseObject(input,['version','kind','definition','definitionDigest','initialized','choices','seenIds','attempts','recordings','lastRefreshAt','discoveryStatus']);
  if(row.version!==1||row.kind!=='release-automation'||typeof row.initialized!=='boolean'||!['not-checked','available','unavailable'].includes(String(row.discoveryStatus)))throw Error('Invalid release automation state');
  const state:ReleaseAutomationState={version:1,kind:'release-automation',definition:readReleaseAutomationDefinition(row.definition),definitionDigest:releaseDigest(row.definitionDigest),initialized:row.initialized,
    choices:list(row.choices,1000).map(readReleaseChoice),seenIds:list(row.seenIds,10000).map(value=>identifier(value,'seen release')),attempts:list(row.attempts).map(attempt),recordings:list(row.recordings,1000).map(recording),discoveryStatus:row.discoveryStatus as ReleaseAutomationState['discoveryStatus']};
  if(row.lastRefreshAt!==undefined)state.lastRefreshAt=time(row.lastRefreshAt);
  for(const values of [state.choices.map(value=>value.id),state.seenIds,state.attempts.map(value=>value.id)])if(new Set(values).size!==values.length)throw Error('Duplicate automation identity');
  return jsonCopy(state) as unknown as ReleaseAutomationState;
}

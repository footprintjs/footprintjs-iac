import {freeze,identifier,jsonCopy} from '../graph/data.ts';
import {readResource} from '../graph/resources.ts';
import {releaseObject,releaseText,releaseDigest} from '../releases/data.ts';
import type {AssessmentObservation,ChangeAssessmentDefinition,ChangeAssessmentReport,ChangeProbe,AssessedResourceChange} from './types.ts';

export const dispositions=['noop','verify','create','update','replace','delete','blocked','unknown'] as const;
export function list(input:unknown,max=256):unknown[]{if(!Array.isArray(input)||input.length>max)throw Error('Invalid bounded assessment list');return input;}
export function codes(input:unknown,max=32):string[]{const result=list(input,max).map(value=>identifier(value,'assessment reason'));if(new Set(result).size!==result.length)throw Error('Duplicate assessment reason');return result;}
export function paths(input:unknown):string[]{const result=list(input,128).map(value=>{
  if(typeof value!=='string'||!/^\/(?:[A-Za-z_][A-Za-z0-9_.-]*)(?:\/(?:[A-Za-z_][A-Za-z0-9_.-]*|\d+))*$/.test(value)||value.length>256)throw Error('Expose only approved schema paths');return value;
});if(new Set(result).size!==result.length)throw Error('Duplicate assessment path');return result;}
export function readAssessmentDefinition(input:unknown):ChangeAssessmentDefinition{
  const row=releaseObject(input,['version','id','label','target','configurationDigest','changes']);if(row.version!==1)throw Error('Unsupported assessment definition');
  identifier(row.id,'assessment');releaseText(row.label,160);releaseDigest(row.configurationDigest);
  const target=releaseObject(row.target,['id','scope']);identifier(target.id,'assessment target');releaseText(target.scope,4096);
  const ids=new Set<string>(),changes=list(row.changes,128);if(!changes.length)throw Error('Register at least one change');
  for(const item of changes){const change=releaseObject(item,['id','label','adapterId','strategyId','data','previous','desired']);
    const id=identifier(change.id,'resource change');if(ids.has(id))throw Error('Duplicate change');ids.add(id);releaseText(change.label,160);
    identifier(change.adapterId,'assessment adapter');identifier(change.strategyId,'assessment strategy');
    if(!['stateless','stateful','unknown'].includes(String(change.data))||change.previous===undefined&&change.desired===undefined)throw Error('Describe resource data and intended change');
    if(change.previous!==undefined)readResource(change.previous);if(change.desired!==undefined)readResource(change.desired);
  }
  return freeze(row as unknown as ChangeAssessmentDefinition);
}
export function readAssessmentObservation(input:unknown):AssessmentObservation{
  const row=releaseObject(input,['exists','fingerprint','physicalId','owned','ready','revision']);if(typeof row.exists!=='boolean')throw Error('Invalid provider observation');
  for(const key of ['owned','ready'])if(row[key]!==undefined&&typeof row[key]!=='boolean')throw Error('Invalid observation flag');
  if(row.fingerprint!==undefined)releaseDigest(row.fingerprint);
  for(const key of ['physicalId','revision'])if(row[key]!==undefined)releaseText(row[key],4096);
  return freeze(row as unknown as AssessmentObservation);
}
export function readChangeProbe(input:unknown):ChangeProbe{
  const row=releaseObject(input,['observation','destination','update','reasons','validation','changedPaths','requirements']);readAssessmentObservation(row.observation);
  if(row.destination!==undefined)readAssessmentObservation(row.destination);
  if(!['supported','replacement-required','rejected','unknown','not-needed'].includes(String(row.update))||!['provider-dry-run','declared-contract','not-checked'].includes(String(row.validation)))throw Error('Invalid provider capability result');
  codes(row.reasons);if(row.changedPaths!==undefined)paths(row.changedPaths);
  if(row.requirements!==undefined)codes(row.requirements);
  return freeze(row as unknown as ChangeProbe);
}
export function readAssessedChange(input:unknown):AssessedResourceChange{
  const row=releaseObject(input,['id','label','resourceId','provider','adapterId','strategyId','data','previousDigest','desiredDigest','changedPaths','disposition','reasons','validation','observed','requirements']);
  for(const key of ['id','resourceId','provider','adapterId','strategyId'])identifier(row[key],'assessed resource');releaseText(row.label,160);
  if(!['stateless','stateful','unknown'].includes(String(row.data))||!dispositions.includes(row.disposition as typeof dispositions[number])||!['provider-dry-run','declared-contract','not-checked'].includes(String(row.validation)))throw Error('Invalid assessment decision');
  for(const key of ['previousDigest','desiredDigest'])if(row[key]!==null)releaseDigest(row[key]);
  paths(row.changedPaths);codes(row.reasons);codes(row.requirements);
  const observed=releaseObject(row.observed,['exists','owned','ready','identityDigest','revisionDigest','fingerprint']);
  if(typeof observed.exists!=='boolean')throw Error('Invalid public observation');for(const key of ['owned','ready'])if(observed[key]!==undefined&&typeof observed[key]!=='boolean')throw Error('Invalid public observation');
  for(const key of ['identityDigest','revisionDigest','fingerprint'])if(observed[key]!==undefined)releaseDigest(observed[key]);
  if(['update','replace','delete','verify'].includes(String(row.disposition))&&(!observed.exists||observed.owned!==true)
    ||row.disposition==='noop'&&(observed.exists?observed.owned!==true:row.desiredDigest!==null))throw Error('Existing resource assessment requires verified ownership');
  return freeze(row as unknown as AssessedResourceChange);
}
/** Browser-safe structure only. /node verifies the digest and native execution before host use. */
export function readChangeAssessmentReportShape(input:unknown):ChangeAssessmentReport{
  const row=releaseObject(input,['kind','schemaVersion','id','label','target','definitionDigest','executionId','assessedAt','changes','digest']);
  if(row.kind!=='change-assessment'||row.schemaVersion!==1)throw Error('Unsupported change assessment');
  identifier(row.id,'assessment');releaseText(row.label,160);releaseText(row.executionId,128);releaseDigest(row.definitionDigest);releaseDigest(row.digest);
  const target=releaseObject(row.target,['id','scopeDigest']);identifier(target.id,'assessment target');releaseDigest(target.scopeDigest);
  if(!Number.isSafeInteger(row.assessedAt)||Number(row.assessedAt)<=0)throw Error('Invalid assessment time');
  const changes=list(row.changes,128).map(readAssessedChange);if(!changes.length||new Set(changes.map(change=>change.id)).size!==changes.length)throw Error('Invalid assessment changes');
  return freeze(jsonCopy(row) as unknown as ChangeAssessmentReport);
}

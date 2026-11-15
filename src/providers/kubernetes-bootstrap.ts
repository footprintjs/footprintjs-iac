import type {Json,JsonObject} from '../types.ts';

function object(value:Json|undefined):JsonObject{return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
/** Unknown/list field encodings conservatively overlap a requested field. */
function fieldsOverlap(fields:Json|undefined,desired:Json|undefined):boolean{
  if(desired===undefined)return false;
  if(!fields||typeof fields!=='object'||Array.isArray(fields))return true;
  const entries=Object.entries(fields);if(!entries.length)return true;
  for(const [key,child] of entries){
    if(key==='.')continue;
    if(!key.startsWith('f:'))return true;
    if(desired===null||typeof desired!=='object'||Array.isArray(desired))return true;
    const name=key.slice(2);
    if(Object.hasOwn(desired,name)&&fieldsOverlap(child,desired[name]))return true;
  }
  return false;
}
/**
 * Shared by actual SSA execution and its read-only preflight. A POST/create's
 * Update manager is distinct from its Apply manager. Only this framework's own
 * bootstrap fields may transition; foreign main-resource or overlapping status
 * field ownership never authorizes force. UID/resourceVersion remain mandatory
 * request preconditions, and this predicate does not establish resource ownership.
 */
export function canMigrateKubernetesBootstrap(live:JsonObject,desired:JsonObject,manager='footprint-iac'):boolean{
  const managed=object(live.metadata).managedFields;
  if(!Array.isArray(managed)||!managed.length)return false;
  let ownBootstrap=false;
  for(const item of managed){
    const entry=object(item);
    if(typeof entry.manager!=='string'||!['Apply','Update'].includes(String(entry.operation))
      ||entry.fieldsType!=='FieldsV1'||!entry.fieldsV1||typeof entry.fieldsV1!=='object'||Array.isArray(entry.fieldsV1))return false;
    const main=entry.subresource===undefined||entry.subresource==='';
    if(entry.manager===manager){
      if(main&&entry.operation==='Update'&&entry.apiVersion===live.apiVersion)ownBootstrap=true;
      continue;
    }
    if(entry.subresource!=='status'||fieldsOverlap(entry.fieldsV1,desired))return false;
  }
  return ownBootstrap;
}

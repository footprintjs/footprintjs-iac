import type {JsonObject} from '../types.ts';
import {canMigrateKubernetesBootstrap} from '../providers/kubernetes-bootstrap.ts';

export interface KubernetesUpdateValidationStrategy{
  id:string;
  /** Pure request declaration. Only the transport may issue the mandatory dry-run PATCH. */
  request(input:{path:string;fieldManager:string;body:JsonObject;existing:boolean;live?:JsonObject}):{
    path:string;body:JsonObject;contentType:'application/apply-patch+yaml'|'application/merge-patch+json';requirements:string[];
  };
}
/** Mirrors an executor using server-side apply without taking competing fields. */
export function serverSideApplyValidation():KubernetesUpdateValidationStrategy{return{id:'server-side-apply',request(input){return{
  path:input.path+'?dryRun=All&fieldManager='+encodeURIComponent(input.fieldManager)+'&fieldValidation=Strict',body:input.body,
  contentType:'application/apply-patch+yaml',requirements:[]};}};}
/**
 * Explicitly matches KubernetesAdapter's bounded own-bootstrap SSA transition.
 * Selects the request before validation; a 409 never triggers a different probe.
 */
export function ownedBootstrapServerSideApplyValidation():KubernetesUpdateValidationStrategy{return{id:'owned-bootstrap-server-side-apply',request(input){
  const bootstrap=!!input.live&&canMigrateKubernetesBootstrap(input.live,input.body,input.fieldManager);
  return{path:input.path+'?dryRun=All&fieldManager='+encodeURIComponent(input.fieldManager)+'&fieldValidation=Strict'+(bootstrap?'&force=true':''),
    body:input.body,contentType:'application/apply-patch+yaml',requirements:bootstrap?['matching-owned-bootstrap-executor']:[]};
}};}
/** Explicit alternative API semantics. It is never an automatic fallback from an SSA ownership conflict. */
export function mergePatchValidation():KubernetesUpdateValidationStrategy{return{id:'merge-patch',request(input){
  if(!input.existing)throw Error('Merge-patch validation requires an existing physical resource');
  return{path:input.path+'?dryRun=All&fieldManager='+encodeURIComponent(input.fieldManager)+'&fieldValidation=Strict',body:input.body,
    contentType:'application/merge-patch+json',requirements:['matching-update-executor','field-ownership-review']};
}};}

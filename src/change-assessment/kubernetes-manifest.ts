import {jsonCopy} from '../graph/data.ts';
import {canonical,fingerprint} from '../util.ts';
import type {Json,JsonObject,Resource} from '../types.ts';
import type {AssessmentObservation} from './types.ts';

const kinds:Record<string,{version:string;plural:string}>={Namespace:{version:'v1',plural:'namespaces'},ConfigMap:{version:'v1',plural:'configmaps'},Service:{version:'v1',plural:'services'},Deployment:{version:'apps/v1',plural:'deployments'}};
const name=/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
export const asObject=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function kubernetesAssessmentAddress(resource:Resource,namespace?:string){
  const spec=resource.spec,kind=String(spec.kind??''),config=kinds[kind],metadata=asObject(spec.metadata),resourceName=String(metadata.name??''),ns=metadata.namespace??namespace;
  if(resource.provider!=='kubernetes'||!config||spec.apiVersion!==config.version||Object.hasOwn(spec,'status')||!name.test(resourceName)||resourceName.length>253
    ||['uid','resourceVersion','managedFields','generation','creationTimestamp','deletionTimestamp'].some(field=>Object.hasOwn(metadata,field)))throw Error('Unsupported Kubernetes assessment manifest');
  if(kind==='Namespace'&&(metadata.namespace!==undefined||resourceName==='default'||resourceName.startsWith('kube-')||namespace&&resourceName!==namespace))throw Error('Refusing an unmanaged namespace scope');
  if(kind!=='Namespace'&&(typeof ns!=='string'||!name.test(ns)||namespace&&namespace!==ns))throw Error('Pin the Kubernetes namespace');
  const prefix=kind==='Deployment'?'/apis/apps/v1':'/api/v1',path=kind==='Namespace'?prefix+'/namespaces/'+resourceName:prefix+'/namespaces/'+ns+'/'+config.plural+'/'+resourceName;
  return{kind,name:resourceName,namespace:kind==='Namespace'?undefined:ns as string,path,version:config.version};
}
function projection(actual:unknown,desired:Json):Json{
  if(Array.isArray(desired))return Array.isArray(actual)?actual.map((item,index)=>index<desired.length?projection(item,desired[index]!):jsonCopy(item)):jsonCopy(actual??null);
  if(desired===null||typeof desired!=='object')return jsonCopy(actual??null);
  return Object.fromEntries(Object.entries(desired).map(([key,value])=>[key,projection(asObject(actual)[key],value)]));
}
export function checkKubernetesObject(input:unknown,resource:Resource,namespace?:string):Record<string,unknown>{
  const live=asObject(jsonCopy(input)),address=kubernetesAssessmentAddress(resource,namespace),metadata=asObject(live.metadata);
  if(live.apiVersion!==address.version||live.kind!==address.kind||metadata.name!==address.name||(address.namespace&&metadata.namespace!==address.namespace)
    ||typeof metadata.uid!=='string'||!metadata.uid||typeof metadata.resourceVersion!=='string'||!metadata.resourceVersion)throw Error('Kubernetes observation identity changed');
  return live;
}
export function kubernetesAssessmentObservation(live:Record<string,unknown>|undefined,resource:Resource,stack:string,namespace?:string):AssessmentObservation{
  if(!live)return{exists:false};const address=kubernetesAssessmentAddress(resource,namespace),metadata=asObject(live.metadata),marks=asObject(metadata.annotations),status=asObject(live.status);
  const owned=marks['footprint-iac.dev/owner']===fingerprint({stack,id:resource.id})&&marks['footprint-iac.dev/stack']===stack&&marks['footprint-iac.dev/resource']===resource.id;
  const replicas=Number(asObject(resource.spec.spec).replicas??1);
  const ready=!metadata.deletionTimestamp&&(address.kind==='Namespace'?status.phase==='Active':address.kind==='Deployment'?
    Number(status.observedGeneration??-1)>=Number(metadata.generation??0)&&Number(status.updatedReplicas??0)===replicas&&Number(status.availableReplicas??0)>=replicas&&Number(status.replicas??0)===replicas:
    address.kind==='Service'&&asObject(resource.spec.spec).type==='LoadBalancer'?Array.isArray(asObject(status.loadBalancer).ingress)&&((asObject(status.loadBalancer).ingress as unknown[]).length>0):true);
  return{exists:true,owned,physicalId:address.path+'#'+metadata.uid,revision:String(metadata.resourceVersion),fingerprint:fingerprint(projection(live,resource.spec)),ready};
}
export function assessmentApplyBody(resource:Resource,stack:string,live?:Record<string,unknown>):JsonObject{
  const spec=jsonCopy(resource.spec) as JsonObject,metadata=asObject(spec.metadata),marks=asObject(metadata.annotations);
  if(['footprint-iac.dev/owner','footprint-iac.dev/stack','footprint-iac.dev/resource'].some(key=>Object.hasOwn(marks,key)))throw Error('Ownership annotations are reserved');
  const before=asObject(live?.metadata);
  spec.metadata={...metadata,annotations:{...marks,'footprint-iac.dev/owner':fingerprint({stack,id:resource.id}),'footprint-iac.dev/stack':stack,'footprint-iac.dev/resource':resource.id},
    ...(live?{uid:before.uid,resourceVersion:before.resourceVersion}:{})} as JsonObject;
  return spec;
}
export const sameKubernetesAddress=(before:Resource,after:Resource,namespace?:string)=>canonical(kubernetesAssessmentAddress(before,namespace))===canonical(kubernetesAssessmentAddress(after,namespace));

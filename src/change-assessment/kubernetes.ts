import {identifier} from '../graph/data.ts';
import {fingerprint} from '../util.ts';
import type {Resource} from '../types.ts';
import type {JsonObject} from '../types.ts';
import {canMigrateKubernetesBootstrap} from '../providers/kubernetes-bootstrap.ts';
import {readChangeProbe} from './data.ts';
import {asObject,assessmentApplyBody,checkKubernetesObject,kubernetesAssessmentAddress,kubernetesAssessmentObservation,sameKubernetesAddress} from './kubernetes-manifest.ts';
import type {KubernetesAssessmentTransport} from './kubernetes-transport.ts';
import type {ChangeAssessmentAdapter,ChangeAssessmentContext,ChangeProbe,ResourceChange} from './types.ts';
import {serverSideApplyValidation,type KubernetesUpdateValidationStrategy} from './kubernetes-validation.ts';
export {createHttpsKubernetesAssessmentTransport,type HttpsKubernetesAssessmentOptions,type KubernetesAssessmentTransport,type KubernetesAssessmentResponse} from './kubernetes-transport.ts';
export {serverSideApplyValidation,ownedBootstrapServerSideApplyValidation,mergePatchValidation,type KubernetesUpdateValidationStrategy} from './kubernetes-validation.ts';

export interface KubernetesChangeAssessmentOptions{id:string;scope:string;stack:string;namespace?:string;transport:KubernetesAssessmentTransport;fieldManager?:string;validationStrategy?:KubernetesUpdateValidationStrategy}
const immutable:Record<string,string[]>={Deployment:['spec.selector'],Service:['spec.clusterIP','spec.clusterIPs','spec.ipFamilies','spec.loadBalancerClass'],ConfigMap:['immutable'],Namespace:[]};
function validationResult(response:{status:number;body:unknown},resource:Resource):{update:ChangeProbe['update'];reasons:string[];changedPaths?:string[]}{
  if(response.status>=200&&response.status<300)return{update:'supported',reasons:['provider-dry-run-accepted']};
  const body=asObject(response.body),details=asObject(body.details),metadata=asObject(resource.spec.metadata),causes=Array.isArray(details.causes)?details.causes.map(asObject):[];
  // Only structured immutable-field validation counts as replacement evidence. Other 422s are invalid configuration.
  const fields=causes.filter(cause=>['FieldValueInvalid','FieldValueForbidden'].includes(String(cause.reason))
    &&(immutable[String(resource.spec.kind)]??[]).includes(String(cause.field))&&typeof cause.message==='string'&&/\bfield is immutable\b/.test(cause.message)).map(cause=>String(cause.field));
  const kind=String(resource.spec.kind).toLowerCase(),reportedKind=String(details.kind??'').toLowerCase();
  if(response.status===422&&body.kind==='Status'&&body.status==='Failure'&&body.code===422&&body.reason==='Invalid'&&details.name===metadata.name
    &&[kind,kind+'s'].includes(reportedKind)&&fields.length)return{update:'replacement-required',reasons:['provider-immutable-field'],changedPaths:[...new Set(fields.map(field=>'/'+field.replaceAll('.','/')))]};
  if(response.status===409)return{update:'unknown',reasons:['provider-version-or-field-conflict']};
  if(response.status===401||response.status===403)return{update:'rejected',reasons:['provider-permission-refused']};
  if(response.status===422||response.status===400)return{update:'rejected',reasons:['provider-configuration-invalid']};
  return{update:'unknown',reasons:['provider-validation-unavailable']};
}
/** Actual server dry-run validation. This adapter never persists a resource or submits DELETE. */
export class KubernetesChangeAssessmentAdapter implements ChangeAssessmentAdapter{
  readonly id:string;readonly provider='kubernetes';readonly scope:string;private readonly options:KubernetesChangeAssessmentOptions;private readonly validationStrategy:KubernetesUpdateValidationStrategy;
  constructor(options:KubernetesChangeAssessmentOptions){this.id=identifier(options.id,'assessment adapter');identifier(options.stack,'assessment stack');
    if(typeof options.scope!=='string'||!options.scope||typeof options.transport?.request!=='function')throw Error('Configure a scoped Kubernetes assessment transport');this.scope=options.scope;
    const manager=identifier(options.fieldManager??'footprint-iac','field manager');this.options={...options,fieldManager:manager,transport:{request:options.transport.request.bind(options.transport)}};
    const strategy=options.validationStrategy??serverSideApplyValidation();identifier(strategy.id,'Kubernetes validation strategy');if(typeof strategy.request!=='function')throw Error('Configure a pure dry-run strategy');this.validationStrategy={id:strategy.id,request:strategy.request.bind(strategy)};
  }
  private async read(resource:Resource){const address=kubernetesAssessmentAddress(resource,this.options.namespace),response=await this.options.transport.request('GET',address.path);
    if(response.status===404)return; if(response.status!==200)throw Error('Kubernetes observation unavailable');return checkKubernetesObject(response.body,resource,this.options.namespace);
  }
  async probe(change:ResourceChange,context:ChangeAssessmentContext):Promise<ChangeProbe>{
    if(context.target.scope!==this.scope)throw Error('Kubernetes assessment scope changed');
    const source=change.previous??change.desired!,live=await this.read(source),observation=kubernetesAssessmentObservation(live,source,this.options.stack,this.options.namespace);
    const base:ChangeProbe={observation,update:'not-needed',reasons:[],validation:'not-checked'};
    if(observation.exists&&!observation.owned)return{...base,update:'rejected',reasons:['resource-not-owned']};
    if(!change.desired)return base;
    const changedIdentity=!!change.previous&&!sameKubernetesAddress(change.previous,change.desired,this.options.namespace);
    if(!changedIdentity&&observation.exists&&observation.fingerprint===fingerprint(change.desired.spec))return base;
    const destination=changedIdentity?await this.read(change.desired):live;
    if(changedIdentity){base.destination=kubernetesAssessmentObservation(destination,change.desired,this.options.stack,this.options.namespace);
      if(base.destination.exists)return{...base,update:'rejected',reasons:['replacement-destination-exists']};}
    const desired=change.desired,address=kubernetesAssessmentAddress(desired,this.options.namespace),body=assessmentApplyBody(desired,this.options.stack,changedIdentity?undefined:live);
    const bodyDigest=fingerprint(body),request=this.validationStrategy.request({path:address.path,fieldManager:this.options.fieldManager!,body:structuredClone(body),existing:!!(changedIdentity?destination:live),
      ...(live&&!changedIdentity?{live:structuredClone(live) as JsonObject}:{})}),url=new URL(request.path,'https://assessment.invalid');
    if(url.origin!=='https://assessment.invalid'||url.pathname!==address.path||url.searchParams.getAll('dryRun').length!==1||url.searchParams.get('dryRun')!=='All'
      ||[...url.searchParams.keys()].some(key=>!['dryRun','fieldManager','fieldValidation','force'].includes(key)||url.searchParams.getAll(key).length!==1)
      ||url.searchParams.get('fieldManager')!==this.options.fieldManager
      ||url.searchParams.has('force')&&(url.searchParams.get('force')!=='true'||request.contentType!=='application/apply-patch+yaml'||!live||changedIdentity
        ||!canMigrateKubernetesBootstrap(live as JsonObject,body,this.options.fieldManager)||!request.requirements.includes('matching-owned-bootstrap-executor'))
      ||!['application/apply-patch+yaml','application/merge-patch+json'].includes(request.contentType)
      ||url.hash||fingerprint(request.body)!==bodyDigest)throw Error('Validation strategies must preserve the admitted body and read-only target');
    const response=await this.options.transport.request('PATCH',request.path,request.body,{contentType:request.contentType});
    const validation=validationResult(response,desired);
    // A successful validation is tied to the requested physical identity, never the dry-run generated UID.
    if(validation.update==='supported'){
      const result=asObject(response.body),metadata=asObject(result.metadata);
      if(result.kind!==desired.spec.kind||result.apiVersion!==desired.spec.apiVersion||metadata.name!==address.name||(address.namespace&&metadata.namespace!==address.namespace))return{...base,update:'unknown',reasons:['provider-validation-identity-mismatch']};
    }
    const fresh=await this.read(source),after=kubernetesAssessmentObservation(fresh,source,this.options.stack,this.options.namespace);
    if(after.exists!==observation.exists||after.physicalId!==observation.physicalId||after.revision!==observation.revision||after.fingerprint!==observation.fingerprint||after.owned!==observation.owned)return{...base,update:'unknown',reasons:['provider-changed-during-assessment']};
    const final=changedIdentity&&validation.update==='supported'?{update:'replacement-required' as const,reasons:['physical-resource-identity-changed']}:validation;
    return readChangeProbe({...base,...final,requirements:request.requirements,validation:'provider-dry-run'});
  }
}

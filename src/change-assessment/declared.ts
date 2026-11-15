import {identifier} from '../graph/data.ts';
import {canonical,fingerprint} from '../util.ts';
import {paths,readAssessmentObservation} from './data.ts';
import type {AssessmentObservation,ChangeAssessmentAdapter,ChangeAssessmentContext,ChangeProbe,ResourceChange} from './types.ts';

export interface DeclaredContractAssessmentOptions {
  id:string;provider:string;scope:string;mutablePaths:readonly string[];replacementPaths:readonly string[];
  observe(change:ResourceChange,context:ChangeAssessmentContext):Promise<AssessmentObservation>;
}
/** Internal leaf paths never leave the host; public paths are the configured schema rules only. */
function leafPaths(before:unknown,after:unknown,path=''):string[]{
  if(canonical(before)===canonical(after))return[];
  if(before===null||after===null||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)||Array.isArray(after))return[path||'/spec'];
  const a=before as Record<string,unknown>,b=after as Record<string,unknown>;
  return[...new Set([...Object.keys(a),...Object.keys(b)])].sort().flatMap(key=>leafPaths(a[key],b[key],path+'/'+key.replaceAll('~','~0').replaceAll('/','~1')));
}
const covers=(rule:string,path:string)=>path===rule||path.startsWith(rule+'/');
/** A host-declared provider contract, separate from a server-validated dry-run capability. */
export class DeclaredContractAssessmentAdapter implements ChangeAssessmentAdapter{
  readonly id:string;readonly provider:string;readonly scope:string;private readonly options:DeclaredContractAssessmentOptions;
  constructor(options:DeclaredContractAssessmentOptions){this.id=identifier(options.id,'assessment adapter');this.provider=identifier(options.provider,'provider');
    if(typeof options.scope!=='string'||!options.scope||typeof options.observe!=='function')throw Error('Configure a scoped provider observation');this.scope=options.scope;
    this.options={...options,mutablePaths:paths([...options.mutablePaths]),replacementPaths:paths([...options.replacementPaths]),observe:options.observe.bind(options)};
  }
  async probe(change:ResourceChange,context:ChangeAssessmentContext):Promise<ChangeProbe>{
    if(context.target.scope!==this.scope||[change.previous,change.desired].some(resource=>resource&&resource.provider!==this.provider))throw Error('Declared provider scope changed');
    const observation=readAssessmentObservation(await this.options.observe(change,context));
    const result:ChangeProbe={observation,update:'not-needed',reasons:[],validation:'declared-contract'};
    if(!change.previous||!change.desired||!observation.exists)return result;
    if(observation.fingerprint!==fingerprint(change.previous.spec)&&observation.fingerprint!==fingerprint(change.desired.spec))return{...result,update:'unknown',reasons:['provider-drift-before-assessment']};
    const changed=leafPaths(change.previous,change.desired),replacement=this.options.replacementPaths.filter(rule=>changed.some(path=>covers(rule,path))),mutable=this.options.mutablePaths.filter(rule=>changed.some(path=>covers(rule,path)));
    result.changedPaths=[...new Set([...replacement,...mutable])].sort();
    if(changed.some(path=>![...this.options.replacementPaths,...this.options.mutablePaths].some(rule=>covers(rule,path))))return{...result,update:'unknown',reasons:['field-capability-not-declared']};
    return{...result,update:replacement.length?'replacement-required':changed.length?'supported':'not-needed',reasons:[replacement.length?'declared-immutable-field':changed.length?'declared-in-place-update':'no-field-change']};
  }
}

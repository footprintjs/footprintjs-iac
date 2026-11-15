import {defineSystemRevision} from '../master/revision.ts';
import type {MasterTarget,SystemRevision} from '../master/types.ts';
import type {InfraGraph} from '../graph/types.ts';
import {fingerprint} from '../util.ts';
import type {SystemdDeploymentOptions} from './types.ts';

/** Pure Master admission captures caller data; source facts never acquire code or grant target effects. */
export function captureSystemdSourceProvenance(input:Pick<SystemdDeploymentOptions,'source'|'artifacts'>,target:MasterTarget,graph:InfraGraph){
 const revision=defineSystemRevision({revisionId:'configured-source-provenance',parentDigest:null,target,graph,
  ...(input.source!==undefined?{source:input.source}:{}),...(input.artifacts!==undefined?{artifacts:input.artifacts}:{})});
 return Object.freeze({...revision.source?{source:revision.source}:{},...revision.artifacts?{artifacts:revision.artifacts}:{}});
}
export function systemdSourceProvenanceDigest(value:Pick<SystemRevision,'source'|'artifacts'>):string{
 return fingerprint({source:value.source??null,artifacts:value.artifacts??null});
}

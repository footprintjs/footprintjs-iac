import {freeze,identifier,jsonCopy} from '../graph/data.ts';
import type {WorkflowEvidenceReference} from './types.ts';

/** Public native-run references contain only registered kinds, content digests and opaque run IDs. */
export function readWorkflowEvidenceReferences(input:unknown):WorkflowEvidenceReference[]{
  const values=jsonCopy(input);
  if(!Array.isArray(values)||values.length>16)throw Error('Register bounded workflow evidence references');
  const seen=new Set<string>();
  for(const value of values){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='digest,kind,runId')throw Error('Workflow evidence references cannot contain private handles');
    identifier(value.kind,'evidence kind');identifier(value.runId,'native run ID');
    if(typeof value.kind!=='string'||value.kind.length>64||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))throw Error('Workflow evidence identity changed');
    const key=value.kind+'|'+value.digest+'|'+value.runId;if(seen.has(key))throw Error('Duplicate workflow evidence reference');seen.add(key);
  }
  return freeze(values as unknown as WorkflowEvidenceReference[]);
}
/** Trusted adapters raise this only while proving that their deployment effects have not started. */
export class DeploymentPreflightRefused extends Error {
  readonly evidence:WorkflowEvidenceReference[];
  constructor(evidence:readonly WorkflowEvidenceReference[]=[]){
    super('Deployment preflight refused effects; inspect its recorded evidence');this.name='DeploymentPreflightRefused';
    this.evidence=readWorkflowEvidenceReferences(evidence);Object.freeze(this);
  }
}
export function combineWorkflowEvidenceReferences(...groups:(readonly WorkflowEvidenceReference[]|undefined)[]):WorkflowEvidenceReference[]{
  const items=groups.flatMap(group=>group?readWorkflowEvidenceReferences(group):[]),seen=new Set<string>();
  return readWorkflowEvidenceReferences(items.filter(item=>{const key=item.kind+'|'+item.digest+'|'+item.runId;if(seen.has(key))return false;seen.add(key);return true;}));
}

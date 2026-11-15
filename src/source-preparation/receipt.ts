import {fingerprint} from '../util.ts';
import {readSourcePreparationState} from './data.ts';

/** Identity for an already-admitted passed receipt. Hashing alone does not validate native files. */
export function sourcePreparationReceiptDigest(input:unknown):string{
 const state=readSourcePreparationState(input);if(state.status!=='passed')throw Error('A complete source preparation receipt is required');
 return fingerprint({kind:'source-preparation-receipt',version:1,definitionDigest:state.definitionDigest,executionId:state.executionId,
  revision:state.results.revision,recipeDigest:state.results.build!.recipeDigest,artifacts:state.results.publication!.artifacts,runId:state.recordings[0]!.runId});
}

import type {ReleaseAutomationAttempt,ReleaseAutomationState,ReleaseSelectionStrategy} from './types.ts';

/** Safe browser projection: no file handles, target scopes, gate tokens, provider bodies or metadata. */
export function projectReleaseAutomationAttempt(attempt:ReleaseAutomationAttempt){
  return{id:attempt.id,releaseId:attempt.releaseId,trigger:attempt.trigger,status:attempt.status,createdAt:attempt.createdAt,
    ...(attempt.source?{source:attempt.source.source}:{}),...(attempt.sourceDigest?{sourceDigest:attempt.sourceDigest}:{}),...(attempt.reason?{reason:attempt.reason}:{}),
    ...(attempt.preparation?{preparation:{status:attempt.preparation.status,executionId:attempt.preparation.executionId,stages:attempt.preparation.stages.map(({id,label,status})=>({id,label,status})),...(attempt.preparation.release?{releaseDigest:attempt.preparation.release.digest}:{})}}:{}),
    ...(attempt.pipeline?{pipeline:{status:attempt.pipeline.status,executionId:attempt.pipeline.executionId,definitionDigest:attempt.pipeline.definitionDigest,releaseDigest:attempt.pipeline.release.digest,
      stages:attempt.pipeline.stages.map(({id,label,status,phase})=>({id,label,status,phase})),...(attempt.pipeline.pendingAction?{pendingAction:{kind:attempt.pipeline.pendingAction.kind,stageId:attempt.pipeline.pendingAction.stageId}}:{})}}:{}),
    recordings:attempt.recordings.map(({runId,complete})=>({runId,complete}))};
}
export function projectReleaseAutomationState(state:ReleaseAutomationState){
  return{id:state.definition.id,label:state.definition.label,automatic:{...state.definition.automatic},initialized:state.initialized,discoveryStatus:state.discoveryStatus,
    ...(state.lastRefreshAt!==undefined?{lastRefreshAt:state.lastRefreshAt}:{}),choices:state.choices.map(choice=>({...choice,source:{...choice.source}})),
    attempts:state.attempts.map(projectReleaseAutomationAttempt)};
}
/** Host policy selects the newest eligible published source choice, never infers semver. */
export function latestPublishedReleaseStrategy(id='latest-published'):ReleaseSelectionStrategy {
  return{id,select({choices,eligibleIds}){const allowed=new Set(eligibleIds);return [...choices].filter(choice=>allowed.has(choice.id)&&choice.publishedAt)
    .sort((a,b)=>Date.parse(b.publishedAt!)-Date.parse(a.publishedAt!)||a.id.localeCompare(b.id))[0]?.id;}};
}

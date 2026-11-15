import {fingerprint} from '../util.ts';
import type {AssessmentObservation,ChangeProbe} from './types.ts';

/** Physical handles stay private; equality, ownership, version and content evidence remain inspectable. */
function observed(input:AssessmentObservation){
  const {physicalId,revision,...facts}=input;
  return{...facts,...(physicalId?{identityDigest:fingerprint(physicalId)}:{}),...(revision?{revisionDigest:fingerprint(revision)}:{})};
}
export function recordedObservation(probe:ChangeProbe){
  return{probeDigest:fingerprint(probe),available:!probe.reasons.includes('provider-observation-unavailable'),source:observed(probe.observation),...(probe.destination?{destination:observed(probe.destination)}:{})};
}
export function recordedCapability(probe:ChangeProbe){
  return{probeDigest:fingerprint(probe),update:probe.update,reasons:probe.reasons,validation:probe.validation,
    ...(probe.changedPaths?{changedPaths:probe.changedPaths}:{}),...(probe.requirements?{requirements:probe.requirements}:{})};
}

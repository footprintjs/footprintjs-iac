import {freeze} from '../graph/data.ts';
import {fingerprint} from '../util.ts';
import {readChangeAssessmentReportShape} from './data.ts';
import type {ChangeAssessmentReport} from './types.ts';
export function sealChangeAssessmentReport(input:Omit<ChangeAssessmentReport,'digest'>):ChangeAssessmentReport{
  const shaped=readChangeAssessmentReportShape({...input,digest:'0'.repeat(64)}),{digest:_,...body}=shaped;return freeze({...body,digest:fingerprint(body)});
}
export function readChangeAssessmentReport(input:unknown):ChangeAssessmentReport{
  const shaped=readChangeAssessmentReportShape(input),{digest,...body}=shaped;
  if(digest!==fingerprint(body))throw Error('Change assessment digest changed');return shaped;
}

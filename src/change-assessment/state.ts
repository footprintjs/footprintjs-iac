import {freeze} from '../graph/data.ts';
import {releaseObject,releaseText,releaseDigest} from '../releases/data.ts';
import {canonical,fingerprint} from '../util.ts';
import {list,readAssessedChange,readAssessmentDefinition} from './data.ts';
import {readChangeAssessmentReport} from './report.ts';
import type {ChangeAssessmentState} from './types.ts';

export function readChangeAssessmentState(input:unknown):ChangeAssessmentState{
  const row=releaseObject(input,['version','kind','definition','definitionDigest','executionId','status','events','decisions','report','recording','error']);
  if(row.version!==1||row.kind!=='change-assessment-state'||!['idle','running','complete','incomplete'].includes(String(row.status)))throw Error('Invalid assessment state');
  const definition=readAssessmentDefinition(row.definition);releaseDigest(row.definitionDigest);
  if(row.definitionDigest!==fingerprint(definition))throw Error('Assessment definition changed');
  if(row.executionId!==null)releaseText(row.executionId,128);if(row.error!==undefined)releaseText(row.error,1024);
  const events=list(row.events,256),statuses=new Map<string,string>();
  for(const [index,item]of events.entries()){
    const event=releaseObject(item,['sequence','executionId','changeId','status','timestamp','runtimeStageId']);
    if(event.sequence!==index+1||event.executionId!==row.executionId||!definition.changes.some(change=>change.id===event.changeId)
      ||!['checking','checked'].includes(String(event.status))||!Number.isFinite(event.timestamp))throw Error('Invalid assessment progress');
    if((statuses.get(String(event.changeId))??'pending')!==(event.status==='checking'?'pending':'checking'))throw Error('Invalid assessment event order');
    releaseText(event.runtimeStageId,256);statuses.set(String(event.changeId),String(event.status));
  }
  const decisions=list(row.decisions,128).map(readAssessedChange);
  decisions.forEach((decision,index)=>{
    const change=definition.changes[index];if(!change||decision.id!==change.id||decision.previousDigest!==(change.previous?fingerprint(change.previous):null)
      ||decision.desiredDigest!==(change.desired?fingerprint(change.desired):null)||decision.adapterId!==change.adapterId||decision.strategyId!==change.strategyId||decision.data!==change.data)throw Error('Assessment decision binding changed');
  });
  if(row.recording!==undefined){const receipt=releaseObject(row.recording,['runId','evidencePath','tracePath','complete']);
    for(const key of ['runId','evidencePath','tracePath'])releaseText(receipt[key],4096);if(typeof receipt.complete!=='boolean')throw Error('Invalid assessment recording');}
  if(row.status==='idle'&&(row.executionId!==null||events.length||decisions.length||row.report||row.recording))throw Error('Started assessment cannot be idle');
  if(row.status!=='idle'&&row.executionId===null)throw Error('Assessment has no execution identity');
  if(row.report!==undefined){const report=readChangeAssessmentReport(row.report);
    if(report.definitionDigest!==row.definitionDigest||report.executionId!==row.executionId||canonical(report.changes)!==canonical(decisions)
      ||report.id!==definition.id||report.target.id!==definition.target.id||report.target.scopeDigest!==fingerprint(definition.target.scope))throw Error('Assessment report binding changed');}
  if(row.status==='complete'&&(decisions.length!==definition.changes.length||[...definition.changes].some(change=>statuses.get(change.id)!=='checked')
    ||!(row.recording as {complete?:boolean}|undefined)?.complete||!row.report))throw Error('Completed assessment lacks measured receipts');
  return freeze(row as unknown as ChangeAssessmentState);
}

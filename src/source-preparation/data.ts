import {freeze,jsonCopy} from '../graph/data.ts';
import {canonical,fingerprint} from '../util.ts';
import {readDeliveryDefinition,readSourceRevision,readSourceSnapshot,readDeliveryBuild,readDeliveryPublication} from '../delivery/data.ts';
import {SOURCE_PREPARATION_STAGE_IDS,type SourcePreparationDefinition,type SourcePreparationState} from './types.ts';

function fail():never{throw Error('Unsupported source preparation data');}
function object(input:unknown,allowed:readonly string[]):Record<string,unknown>{const value=jsonCopy(input);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail();return value;}
function text(value:unknown,max=4096):void{if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail();}
function list(value:unknown,max:number):unknown[]{if(!Array.isArray(value)||value.length>max)fail();return value;}
export function readSourcePreparationDefinition(input:unknown):SourcePreparationDefinition{
 const value=object(input,['id','label','target','source','recipe','configurationDigest','expectedRevision']),{expectedRevision,...base}=value;
 const definition=readDeliveryDefinition(base);
 if(expectedRevision!==undefined){const revision=readSourceRevision(expectedRevision);if(revision.repository!==definition.source.repository||revision.ref!==definition.source.ref)fail();}
 return freeze(value as unknown as SourcePreparationDefinition);
}
const readers=[['revision',readSourceRevision],['source',readSourceSnapshot],['build',readDeliveryBuild],['publication',readDeliveryPublication]] as const;
export function readSourcePreparationState(input:unknown):SourcePreparationState{
 const value=object(input,['version','kind','definition','definitionDigest','executionId','status','stages','events','results','recordings','error']);
 if(value.version!==1||value.kind!=='source-preparation-state')fail();const definition=readSourcePreparationDefinition(value.definition);
 if(value.definitionDigest!==fingerprint(definition))fail();if(value.executionId!==null)text(value.executionId,256);
 if(!['idle','running','passed','failed','incomplete'].includes(String(value.status)))fail();if(value.error!==undefined)text(value.error);
 const stages=list(value.stages,4);if(stages.length!==4)fail();stages.forEach((input,index)=>{const stage=object(input,['id','label','status']);if(stage.id!==SOURCE_PREPARATION_STAGE_IDS[index]||!['pending','running','passed','failed'].includes(String(stage.status)))fail();text(stage.label,160);});
 const projected=new Map<string,string>(SOURCE_PREPARATION_STAGE_IDS.map(id=>[id,'pending']));let last=0;
 for(const [index,input] of list(value.events,8).entries()){
  const event=object(input,['sequence','executionId','stageId','status','timestamp','runtimeStageId']),stageIndex=SOURCE_PREPARATION_STAGE_IDS.indexOf(event.stageId as typeof SOURCE_PREPARATION_STAGE_IDS[number]);
  if(event.sequence!==index+1||event.executionId!==value.executionId||stageIndex<0||stageIndex<last||!Number.isFinite(event.timestamp)||!['running','passed','failed'].includes(String(event.status)))fail();
  if(SOURCE_PREPARATION_STAGE_IDS.slice(0,stageIndex).some(id=>projected.get(id)!=='passed'))fail();const before=projected.get(String(event.stageId));
  if(before==='pending'?event.status!=='running':before!=='running'||event.status==='running')fail();text(event.runtimeStageId,256);projected.set(String(event.stageId),String(event.status));last=stageIndex;
 }
 if(stages.some(s=>projected.get((s as {id:string}).id)!==(s as {status:string}).status))fail();
 const results=object(value.results,['revision','source','build','publication']);for(const [key,reader] of readers)if(results[key]!==undefined)reader(results[key]);
 const revision=results.revision as SourcePreparationState['results']['revision'],source=results.source as SourcePreparationState['results']['source'],build=results.build as SourcePreparationState['results']['build'],publication=results.publication as SourcePreparationState['results']['publication'];
 if(revision&&(revision.repository!==definition.source.repository||revision.ref!==definition.source.ref||definition.expectedRevision&&canonical(revision)!==canonical(definition.expectedRevision)))fail();
 if(source&&(!revision||canonical(source.revision)!==canonical(revision)))fail();if(build&&(!source||build.recipeDigest!==definition.recipe.digest))fail();
 if(publication&&(!build||publication.artifacts.length!==build.artifacts.length||publication.artifacts.some(a=>!build.artifacts.some(b=>a.id===b.id&&a.digest===b.digest))))fail();
 readers.forEach(([key],index)=>{const status=(stages[index] as {status:string}).status;if(status==='passed'&&results[key]===undefined||status==='pending'&&results[key]!==undefined)fail();});
 const recordings=list(value.recordings,1);for(const input of recordings){const r=object(input,['runId','evidencePath','tracePath','status']);text(r.runId,256);text(r.evidencePath);text(r.tracePath);if(!['passed','failed','incomplete'].includes(String(r.status)))fail();}
 if(value.status==='idle'&&(value.executionId!==null||(value.events as unknown[]).length||Object.keys(results).length||recordings.length))fail();
 if(value.status!=='idle'&&value.executionId===null)fail();if(value.status==='failed'&&!stages.some(s=>(s as {status:string}).status==='failed'))fail();
 if(value.status==='passed'&&(!stages.every(s=>(s as {status:string}).status==='passed')||readers.some(([key])=>results[key]===undefined)||(recordings[0] as {status?:string}|undefined)?.status!=='passed'))fail();
 return freeze(value as unknown as SourcePreparationState);
}

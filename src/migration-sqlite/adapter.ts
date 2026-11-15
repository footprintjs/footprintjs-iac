import { canonical, fingerprint } from '../util.ts';
import { identifier } from '../graph/data.ts';
import type { MigrationAdapter, MigrationDefinition, MigrationPlan, MigrationReceipt, MigrationRequest, MigrationStep } from '../migration/types.ts';
import { measureSqlite } from './measurement.ts';
import { loadSqliteRun, saveSqliteRun, sqliteRequest } from './run-state.ts';
import { assertSqliteFence, sqliteIdentity, sqliteObservation } from './observations.ts';
import { backupSqlite, createSqliteCandidate, quiesceSqlite, transferSqlite, verifySqliteData } from './prepare-operations.ts';
import { cutoverSqlite, resumeSqlite, resumeSqliteSource, retainSqlite } from './cutover-operations.ts';
import type { SqliteMigrationAdapterOptions, SqliteMigrationContext } from './context.ts';
import type { SqliteMeasurement } from './types.ts';

const phases=['inspect','quiesce','backup','create','transfer','verify-data','cutover','verify-consumer','retain','resume','verify-recovery','resume-source'] as const;
export interface SqliteMigrationAdapter extends MigrationAdapter {
  configurationDigest:string;
  resources():Promise<{source:MigrationDefinition['source'];destination:MigrationDefinition['destination']}>;
  inspectSource():Promise<SqliteMeasurement>;
}
/** Offline replacement for an explicitly cooperating single-host SQLite consumer; it never deletes or blindly restores a database. */
export function createSqliteMigrationAdapter(input:SqliteMigrationAdapterOptions):SqliteMigrationAdapter{
  const options:SqliteMigrationAdapterOptions=Object.freeze({...input,migration:Object.freeze({...input.migration,run:input.migration.run.bind(input.migration)}),
    invariants:Object.freeze({...input.invariants,read:input.invariants.read.bind(input.invariants)}),verifyConsumer:Object.freeze({...input.verifyConsumer,run:input.verifyConsumer.run.bind(input.verifyConsumer)}),
    ...(input.verifySource?{verifySource:Object.freeze({...input.verifySource,run:input.verifySource.run.bind(input.verifySource)})}:{})});
  identifier(options.id,'SQLite migration adapter');identifier(options.sourceDatabaseId,'SQLite source');identifier(options.targetDatabaseId,'SQLite target');
  if(options.sourceDatabaseId===options.targetDatabaseId||![options.sourceSchemaVersion,options.targetSchemaVersion].every(version=>Number.isSafeInteger(version)&&version>=1&&version<=2147483647))throw Error('Register a distinct SQLite replacement candidate and schema contract');
  for(const program of [options.migration,options.invariants,options.verifyConsumer,...(options.verifySource?[options.verifySource]:[])]){identifier(program.id,'SQLite migration program');if(!/^[a-f0-9]{64}$/.test(program.digest))throw Error('Pin each trusted SQLite program digest');}
  if(typeof options.migration.run!=='function'||typeof options.invariants.read!=='function'||typeof options.verifyConsumer.run!=='function'||options.verifySource&&typeof options.verifySource.run!=='function')throw Error('Register each trusted SQLite migration/check program');
  const store=options.consumer.store,configurationDigest=fingerprint({adapter:'sqlite-offline-replacement-v1',scope:store.scope,sourceDatabaseId:options.sourceDatabaseId,targetDatabaseId:options.targetDatabaseId,sourceSchemaVersion:options.sourceSchemaVersion,targetSchemaVersion:options.targetSchemaVersion,
    migration:{id:options.migration.id,digest:options.migration.digest},invariants:{id:options.invariants.id,digest:options.invariants.digest},consumer:{id:options.verifyConsumer.id,digest:options.verifyConsumer.digest},sourceProbe:options.verifySource?{id:options.verifySource.id,digest:options.verifySource.digest}:null});
  function admitRequest(input:MigrationRequest):MigrationRequest{
    const request=sqliteRequest(input);
    if(request.source.id!==options.sourceDatabaseId||request.destination.id!==options.targetDatabaseId||request.source.scope!==store.scope||request.destination.scope!==store.scope
      ||!/^[a-f0-9]{64}$/.test(request.source.identity))throw Error('SQLite request differs from the host-registered source and target');return request;
  }
  async function context(request:MigrationRequest):Promise<SqliteMigrationContext>{return {options,configurationDigest,request,state:await loadSqliteRun(store,request,configurationDigest)};}
  async function receipt(current:SqliteMigrationContext,status:MigrationReceipt['status'],consumer?:MigrationReceipt['consumer']):Promise<MigrationReceipt>{
    const observation=await sqliteObservation(current);return {request:current.request,status,observation,
      ...(observation.backup?{backup:observation.backup}:{}),...(current.state.verification?{verification:current.state.verification}:{}),...(consumer?{consumer}:{}),
      metadata:{programs:{migration:options.migration.id,invariants:options.invariants.id,consumer:options.verifyConsumer.id},sourceRetained:true,automaticRollback:false}};
  }
  async function verifyConsumer(request:MigrationRequest,source=false):Promise<MigrationReceipt>{
    const probe=source?options.verifySource:options.verifyConsumer;if(!probe)throw Error('No original consumer probe is registered');
    await store.withLock(async()=>{const current=await context(request);await assertSqliteFence(current);const observation=await sqliteObservation(current);
      if(source?(observation.active!=='source'||current.state.cutoverIntent||canonical(await store.pointer())!==canonical(current.state.sourcePointer))
        :(observation.active!=='destination'||!current.state.cutover||canonical(await store.pointer())!==canonical(current.state.cutover)))throw Error('SQLite consumer probe requires its exact active pointer');});
    // The durable fence stays held while this registered probe reads through the actual consumer pointer.
    let passed=false;try{passed=await probe.run(options.consumer)===true;}catch{/* No raw application data/errors enters evidence. */}
    return store.withLock(async()=>{const current=await context(request);await assertSqliteFence(current);const observation=await sqliteObservation(current);
      if(source?(observation.active!=='source'||canonical(await store.pointer())!==canonical(current.state.sourcePointer))
        :(observation.active!=='destination'||!observation.destination||canonical(await store.pointer())!==canonical(current.state.cutover)))throw Error('SQLite active consumer changed during verification');
      const activeIdentity=source?observation.source.identity:observation.destination!.identity;
      if(source)current.state.sourceVerified=passed;else current.state.consumerVerified=passed;await saveSqliteRun(store,current.state);
      return receipt(current,passed?'succeeded':'failed',{id:probe.id,digest:fingerprint({id:probe.id,digest:probe.digest,activeIdentity,passed}),passed,activeIdentity});
    });
  }
  const adapter:SqliteMigrationAdapter={id:options.id,label:options.label,configurationDigest,capabilities:Object.freeze(phases.filter(phase=>options.verifySource||!['verify-recovery','resume-source'].includes(phase))),
    admit(definition:MigrationDefinition,plan:MigrationPlan){
      if(definition.configurationDigest!==configurationDigest||definition.source.id!==options.sourceDatabaseId||definition.destination.id!==options.targetDatabaseId
        ||definition.source.scope!==store.scope||definition.destination.scope!==store.scope||definition.parameters&&Object.keys(definition.parameters).length)throw Error('SQLite migration definition differs from its registered host configuration');
      if(plan.steps.some(step=>step.operation!==step.phase||!phases.includes(step.operation as typeof phases[number])))throw Error('SQLite adapter supports only its registered offline operations');
    },
    resources:()=>store.withLock(async()=>{const measured=await measureSqlite(store,store.databasePath(options.sourceDatabaseId),options.invariants);return {source:{id:options.sourceDatabaseId,scope:store.scope,identity:measured.identity},destination:{id:options.targetDatabaseId,scope:store.scope}};}),
    inspectSource:()=>store.withLock(async()=>{const {scope:_,...measurement}=await measureSqlite(store,store.databasePath(options.sourceDatabaseId),options.invariants);return measurement;}),
    observe:input=>store.withLock(async()=>sqliteObservation(await context(admitRequest(input)))),
    async execute(step,input){
      const request=admitRequest(input);
      if(canonical(request.step)!==canonical({id:step.id,phase:step.phase,operation:step.operation})||step.operation!==step.phase||!phases.includes(step.operation as typeof phases[number]))throw Error('SQLite operation does not match its bound native step');
      if(step.phase==='verify-consumer'||step.phase==='verify-recovery')return verifyConsumer(request,step.phase==='verify-recovery');
      return store.withLock(async()=>{
        const current=await context(request);await saveSqliteRun(store,current.state);
        try{
          if(step.phase==='inspect'){
            const observation=await sqliteObservation(current),measurement=await measureSqlite(store,store.databasePath(options.sourceDatabaseId),options.invariants);
            if(observation.active!=='source'||observation.fence||measurement.schemaVersion!==options.sourceSchemaVersion||(await store.pointer()).schemaVersion!==options.sourceSchemaVersion)throw Error('Inspect an active unfenced SQLite source with its declared schema contract');
          }else if(step.phase==='quiesce')await quiesceSqlite(current);
          else if(step.phase==='backup')await backupSqlite(current);
          else if(step.phase==='create')await createSqliteCandidate(current);
          else if(step.phase==='transfer')await transferSqlite(current);
          else if(step.phase==='verify-data')await verifySqliteData(current);
          else if(step.phase==='cutover')await cutoverSqlite(current);
          else if(step.phase==='retain')await retainSqlite(current);
          else if(step.phase==='resume')await resumeSqlite(current);
          else if(step.phase==='resume-source')await resumeSqliteSource(current);
          else throw Error('Unsupported SQLite migration operation');
          return receipt(current,current.state.verification?.passed===false&&step.phase==='verify-data'?'failed':'succeeded');
        }catch{
          // A failed precondition or measured invariant never authorizes deletion, pointer rollback or repeat effects.
          return receipt(current,['backup','create','transfer','cutover','resume','resume-source'].includes(step.phase)?'unknown':'failed');
        }
      });
    }};
  return Object.freeze(adapter);
}

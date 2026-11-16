import {randomUUID} from 'node:crypto';

interface AttemptState {executionId:string|null;status:'idle'|'running'|'passed'|'failed'|'incomplete'}
interface AttemptStore<State> {withLock<T>(work:()=>Promise<T>):Promise<T>;save(state:State):Promise<void>}
/** A retained success replays; synced running intent precedes native execution. */
export function startPreparationAttempt<State extends AttemptState>(options:{
 store:AttemptStore<State>;load():Promise<State>;publish(state:State):void;run(state:State):Promise<State>;blocked:string;replay?(state:State):State;
}):Promise<State>{
 return options.store.withLock(async()=>{
  const loaded=await options.load();if(loaded.status==='passed')return options.replay?options.replay(loaded):loaded;
  if(loaded.status!=='idle')throw Error(options.blocked);
  const state=structuredClone(loaded);state.executionId=randomUUID();state.status='running';
  await options.store.save(state);options.publish(state);return options.run(state);
 });
}

import { join } from 'node:path';
import { FileStateStore } from '../../../src/store.ts';
import type { PipelineWorkflowPort } from '../../../src/pipeline/types.ts';

/** Share the existing GitHub-delivery ownership lock across the selected release environments. */
export function lockNeoReleasePipeline(directories: readonly string[], workflow: PipelineWorkflowPort): PipelineWorkflowPort {
  const locks = [...new Set(directories)].sort().map(directory=>new FileStateStore(join(directory,'delivery-execution-locks')));
  function locked<T>(work:()=>Promise<T>,index=0):Promise<T>{return index===locks.length?work():locks[index]!.withLock('github-delivery',()=>locked(work,index+1));}
  return {snapshot:workflow.snapshot.bind(workflow),subscribe:workflow.subscribe.bind(workflow),
    start:()=>locked(()=>workflow.start()),promote:request=>locked(()=>workflow.promote(request)),recover:request=>locked(()=>workflow.recover(request))};
}

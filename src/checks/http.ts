import { performance } from 'node:perf_hooks';
import { readCheckCatalog, readCheckRequest, readCheckResult, checkStatus } from './data.ts';
import type { CheckObservation, CheckRequest, CheckRunner, CheckSuite } from './types.ts';

export interface HttpCheck { id: string; url: string; expectedStatus?: number; method?: 'GET'|'HEAD'; bodyIncludes?: string }
export interface HttpCheckSuite extends CheckSuite { requests: readonly HttpCheck[] }
/** Endpoints are fixed by the host; a check request cannot redirect the runner to another URL. */
export class HttpCheckAdapter implements CheckRunner {
  readonly id: string;
  private readonly catalog: readonly CheckSuite[];
  private readonly definitions: readonly HttpCheckSuite[];
  private readonly timeoutMs: number;
  constructor(options: { id: string; suites: readonly HttpCheckSuite[]; timeoutMs?: number }) {
    this.id=options.id; this.catalog=readCheckCatalog(options.suites.map(({requests,...suite})=>suite));
    this.definitions=options.suites.map(suite=>({ ...suite, requests:suite.requests.map(check=>{
      const url=new URL(check.url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search
        || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(check.id) || (check.method && !['GET','HEAD'].includes(check.method))) throw Error('Configure fixed non-secret HTTP checks');
      if (check.expectedStatus !== undefined && (!Number.isInteger(check.expectedStatus) || check.expectedStatus<100 || check.expectedStatus>599)) throw Error('Configure an HTTP status');
      if (check.bodyIncludes !== undefined && (typeof check.bodyIncludes!=='string' || check.bodyIncludes.length>4096)) throw Error('Bound HTTP body predicate');
      return { ...check };
    }) }));
    if(this.definitions.some(suite=>!suite.requests.length || suite.requests.length>128 || new Set(suite.requests.map(check=>check.id)).size!==suite.requests.length)) throw Error('Configure unique bounded HTTP checks');
    this.timeoutMs=options.timeoutMs??10_000;
    if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>60_000)throw Error('Bound HTTP timeout');
  }
  suites(): readonly CheckSuite[] { return this.catalog; }
  async run(input: CheckRequest) {
    const request=readCheckRequest(input), suite=this.definitions.find(suite=>suite.id===request.suiteId&&suite.digest===request.suiteDigest);
    if(!suite)throw Error('Choose a configured HTTP suite');
    const checks:CheckObservation[]=[];
    for(const check of suite.requests){
      const start=performance.now();
      try{
        const response=await fetch(check.url,{method:check.method??'GET',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
        let matches=response.status===(check.expectedStatus??200);
        if(check.bodyIncludes!==undefined){
          const reader=response.body?.getReader(),decoder=new TextDecoder();let size=0,body='';
          if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>1024*1024)throw Error('HTTP check body too large');body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();}finally{await reader.cancel();}
          matches&&=body.includes(check.bodyIncludes);
        }else await response.body?.cancel();
        checks.push({id:check.id,status:matches?'passed':'failed',statusCode:response.status,durationMs:Math.round(performance.now()-start)});
      }catch{checks.push({id:check.id,status:'error',durationMs:Math.round(performance.now()-start)});}
    }
    return readCheckResult({request,status:checkStatus(checks),checks});
  }
}

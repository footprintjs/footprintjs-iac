import { execFile } from 'node:child_process';
import { readCheckCatalog, readCheckRequest, readCheckResult, checkStatus } from './data.ts';
import type { CheckObservation, CheckRequest, CheckRunner, CheckSuite } from './types.ts';

export interface CheckCommand { program: string; args: readonly string[]; cwd?: string; env?: Record<string,string> }
export interface CheckCommandOutput { stdout: string; exitCode: number }
export type CheckCommandDriver=(command:CheckCommand,timeoutMs:number)=>Promise<CheckCommandOutput>;
export interface CommandCheckSuite extends CheckSuite { command: CheckCommand }
export type CheckReportParser=(stdout:string)=>CheckObservation[];
const defaultDriver:CheckCommandDriver=(command,timeoutMs)=>new Promise((resolve,reject)=>{
  execFile(command.program,[...command.args],{cwd:command.cwd,env:{...process.env,...command.env},timeout:timeoutMs,maxBuffer:8*1024*1024},(error,stdout)=>{
    if(error && typeof error.code!=='number'){reject(Error('Configured test process did not complete'));return;}
    resolve({stdout,exitCode:error?Number(error.code):0});
  });
});
export function parseCheckReport(stdout:string):CheckObservation[]{
  if(Buffer.byteLength(stdout)>8*1024*1024)throw Error('Bound test report');
  const report=JSON.parse(stdout) as {checks?:unknown};
  if(!Array.isArray(report.checks))throw Error('Expected a check report');
  return report.checks as CheckObservation[];
}
/** The host registers executable/arguments once; the browser and request supply only suite identities. */
export class CommandCheckAdapter implements CheckRunner {
  readonly id:string;private readonly catalog:readonly CheckSuite[];private readonly definitions:readonly CommandCheckSuite[];
  private readonly driver:CheckCommandDriver;private readonly parser:CheckReportParser;private readonly timeoutMs:number;
  constructor(options:{id:string;suites:readonly CommandCheckSuite[];driver?:CheckCommandDriver;parse?:CheckReportParser;timeoutMs?:number}){
    this.id=options.id;this.catalog=readCheckCatalog(options.suites.map(({command,...suite})=>suite));
    this.definitions=options.suites.map(suite=>{
      const command=suite.command;
      if(!command||typeof command.program!=='string'||!command.program||command.program.length>4096||/[\x00-\x1f\x7f]/.test(command.program)
        ||!Array.isArray(command.args)||command.args.length>128||command.args.some(arg=>typeof arg!=='string'||arg.length>4096||/[\x00\x7f]/.test(arg)))throw Error('Configure a bounded trusted test command');
      if(command.cwd!==undefined&&(typeof command.cwd!=='string'||!command.cwd||command.cwd.length>4096||/[\x00-\x1f\x7f]/.test(command.cwd)))throw Error('Configure a trusted test working directory');
      if(command.env!==undefined&&(!command.env||typeof command.env!=='object'||Array.isArray(command.env)||Object.keys(command.env).length>128
        ||Object.entries(command.env).some(([key,value])=>!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)||typeof value!=='string'||value.length>16384||/[\x00]/.test(value))))throw Error('Configure bounded host-only test environment');
      return {...suite,command:{...command,args:[...command.args],...(command.env?{env:{...command.env}}:{})}};
    });
    this.driver=options.driver??defaultDriver;this.parser=options.parse??parseCheckReport;this.timeoutMs=options.timeoutMs??60_000;
    if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>600_000)throw Error('Bound test timeout');
  }
  suites():readonly CheckSuite[]{return this.catalog;}
  async run(input:CheckRequest){
    const request=readCheckRequest(input),suite=this.definitions.find(suite=>suite.id===request.suiteId&&suite.digest===request.suiteDigest);
    if(!suite)throw Error('Choose a configured test suite');
    try{
      const output=await this.driver(suite.command,this.timeoutMs);
      const checks=this.parser(output.stdout),status=checkStatus(checks);
      if(![0,1].includes(output.exitCode)||(output.exitCode!==0&&status==='passed'))throw Error('Process outcome differs from report');
      return readCheckResult({request,status,checks});
    }catch{return readCheckResult({request,status:'error',checks:[{id:'runner',status:'error'}]});}
  }
}

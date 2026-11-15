import { canonical } from '../util.ts';
import { readCheckCatalog, readCheckRequest, readCheckResult } from './data.ts';
import type { CheckRequest, CheckResult, CheckRunner, CheckSuite } from './types.ts';

/** Open tool registry; no vendor or test-framework switch belongs in the execution core. */
export class CheckRunnerRegistry {
  private readonly runners = new Map<string,{ runner: CheckRunner; suites: readonly CheckSuite[] }>();
  constructor(runners: readonly CheckRunner[]) {
    if (!Array.isArray(runners) || !runners.length || runners.length > 64) throw Error('Configure a bounded check runner registry');
    for (const runner of runners) {
      if (!runner || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runner.id) || this.runners.has(runner.id)
        || typeof runner.run !== 'function' || typeof runner.suites !== 'function') throw Error('Configure unique check runners');
      this.runners.set(runner.id,{ runner, suites: readCheckCatalog(runner.suites()) });
    }
  }
  catalog(): { id: string; suites: readonly CheckSuite[] }[] {
    return [...this.runners].map(([id,{suites}]) => ({ id, suites: structuredClone(suites) }));
  }
  async run(runnerId: string, input: CheckRequest): Promise<CheckResult> {
    const request = readCheckRequest(input), selected = this.runners.get(runnerId);
    if (!selected?.suites.some(suite => suite.id === request.suiteId && suite.digest === request.suiteDigest)) throw Error('Choose a registered immutable check suite');
    let result: CheckResult;
    try { result = readCheckResult(await selected.runner.run(request)); }
    catch { return readCheckResult({ request, status:'error', checks:[{id:'runner',status:'error'}] }); }
    if (canonical(result.request) !== canonical(request)) throw Error('Check result belongs to a different release, stage or invocation');
    return result;
  }
}

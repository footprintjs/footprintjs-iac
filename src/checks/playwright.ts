import { CommandCheckAdapter, type CheckCommandDriver } from './command.ts';
import type { CheckObservation, CheckRunner, CheckSuite } from './types.ts';

export interface PlaywrightCheckSuite extends CheckSuite { suite: string; project?: string }
/** Parses the standard JSON reporter. Unexpected/flaky/unfinished tests do not pass a release gate. */
export function parsePlaywrightReport(stdout: string): CheckObservation[] {
  if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) throw Error('Bound Playwright report');
  const report = JSON.parse(stdout) as { suites?: unknown[]; errors?: unknown[] };
  if (!Array.isArray(report.suites) || (report.errors !== undefined && !Array.isArray(report.errors))) throw Error('Expected Playwright JSON reporter');
  const observations: CheckObservation[] = [];
  let remaining = 8192;
  function visit(suites: unknown[], depth: number): void {
    if (depth > 32) throw Error('Bound Playwright nesting');
    for (const item of suites) {
      if (--remaining < 0 || !item || typeof item !== 'object') throw Error('Bound Playwright report');
      const suite = item as { suites?: unknown[]; specs?: unknown[] };
      if (suite.suites !== undefined) { if (!Array.isArray(suite.suites)) throw Error('Invalid Playwright suites'); visit(suite.suites, depth + 1); }
      if (suite.specs !== undefined) {
        if (!Array.isArray(suite.specs)) throw Error('Invalid Playwright specs');
        for (const spec of suite.specs) {
          if (--remaining < 0 || !spec || typeof spec !== 'object' || !Array.isArray((spec as { tests?: unknown }).tests)) throw Error('Invalid Playwright tests');
          for (const test of (spec as { tests: unknown[] }).tests) {
            if (--remaining < 0 || !test || typeof test !== 'object') throw Error('Invalid Playwright test');
            const value = test as { status?: string; results?: { status?: string }[] };
            if (!Array.isArray(value.results)) throw Error('Invalid Playwright results');
            const passed = value.status === 'expected' && value.results.length > 0 && value.results.every(result => result.status === 'passed');
            const status = passed ? 'passed' : value.status === 'skipped' ? 'skipped'
              : value.status === 'unexpected' || value.status === 'flaky' ? 'failed' : 'inconclusive';
            observations.push({ id: 'test-' + (observations.length + 1), status });
          }
        }
      }
    }
  }
  visit(report.suites, 0);
  if (report.errors?.length) observations.push({ id: 'playwright-errors', status: 'error' });
  if (!observations.length) observations.push({ id: 'playwright-empty', status: 'inconclusive' });
  return observations;
}
/** Optional tool adapter: uses an already installed trusted CLI. It never downloads Playwright or browsers. */
export function playwrightCheckAdapter(options: {
  id: string; cli: string; cwd: string; suites: readonly PlaywrightCheckSuite[];
  env?: Record<string, string>; timeoutMs?: number; driver?: CheckCommandDriver;
}): CheckRunner {
  return new CommandCheckAdapter({ id: options.id, timeoutMs: options.timeoutMs, driver: options.driver,
    parse: parsePlaywrightReport, suites: options.suites.map(({ suite, project, ...catalog }) => {
      if (typeof suite !== 'string' || !suite || suite.startsWith('-') || suite.length > 4096
        || (project !== undefined && (!project || project.startsWith('-') || project.length > 128))) throw Error('Register a trusted Playwright suite');
      return { ...catalog, command: { program: options.cli, cwd: options.cwd,
        ...(options.env ? { env: options.env } : {}), args: ['test', suite, '--reporter=json', '--workers=1', ...(project ? ['--project=' + project] : [])] } };
    }) });
}

import { readFile } from 'node:fs/promises';
import { assertExecutableGraph } from './graph/validation.ts';
import { explainRun } from './diagnostics/explain.ts';
import { cleanupStack } from './cli/cleanup-stack.ts';
import { resolve } from 'node:path';
import { InfraEngine } from './engine.ts';
import { FileStateStore } from './store.ts';
import { SimulatorAdapter } from './providers/simulator.ts';
import { KubernetesAdapter } from './providers/kubernetes.ts';
import { backwalk, loadEvidence, replay } from './evidence.ts';
import type { ResourceAdapter, Stack } from './types.ts';
import { errorMessage } from './util.ts';

const usage = `Usage:
  npm run iac -- plan|apply|destroy STACK.json [--context CONTEXT] [--namespace NS] [--state-dir DIR] [--max-concurrency N] [--prune]
  npm run iac -- replay RUN.json [--commit INDEX]
  npm run iac -- explain RUN.json [--key failure]
  npm run iac -- inspect RUN.json [--key failure]

Kubernetes always requires an explicit --context. KUBECONFIG selects the config file.
apply preserves completed work on failure; --prune removes only absent resources in saved inventory.
destroy removes saved owned resources except namespaces, which require a separate reviewed cleanup.
`;

function argumentsFor(argv: string[]) {
  const [command, path, ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index]!;
    if (!['--context', '--namespace', '--state-dir', '--commit', '--key', '--prune', '--max-concurrency'].includes(name)) throw new Error(`Unknown option: ${name}`);
    if (options.has(name)) throw new Error(`Repeated option: ${name}`);
    if (name === '--prune') { options.set(name, 'true'); continue; }
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    options.set(name, value);
  }
  return { command, path, options };
}

async function main(): Promise<void> {
  if (process.argv.length < 4 || process.argv.includes('--help')) { console.log(usage); return; }
  const { command, path, options } = argumentsFor(process.argv.slice(2));
  if (!path) throw new Error(usage);
  if (command === 'explain' || command === 'replay' || command === 'inspect') {
    const evidence = await loadEvidence(path);
    if (command === 'inspect') console.log(JSON.stringify(explainRun(evidence, options.get('--key') ?? 'failure'), null, 2));
    else if (command === 'explain') console.log(backwalk(evidence, options.get('--key') ?? 'failure').text);
    else {
      const commit = options.has('--commit') ? Number(options.get('--commit')) : undefined;
      if (commit !== undefined && (!Number.isInteger(commit) || commit < -1 || commit >= evidence.snapshot.commitLog.length)) throw new Error('Commit is outside the recorded range');
      console.log(JSON.stringify(replay(evidence, commit), null, 2));
    }
    return;
  }
  if (!['plan', 'apply', 'destroy'].includes(command ?? '')) throw new Error(usage);
  let stack = JSON.parse(await readFile(resolve(path), 'utf8')) as Stack;
  assertExecutableGraph(stack);
  const directory = resolve(options.get('--state-dir') ?? '.footprint-iac');
  const store = new FileStateStore(directory);
  const providers = new Set(stack.resources.map(r => r.provider));
  const savedState = await store.load(stack.name);
  for (const resource of Object.values(savedState.resources)) providers.add(resource.resource.provider);
  const adapters: ResourceAdapter[] = [];
  for (const provider of providers) {
    if (provider === 'simulator') adapters.push(new SimulatorAdapter({ file: resolve(directory, 'simulator-provider.json') }));
    else if (provider === 'kubernetes') {
      const context = options.get('--context');
      if (!context) throw new Error('Kubernetes requires an explicit --context');
      adapters.push(new KubernetesAdapter({ context, namespace: options.get('--namespace') }));
    } else throw new Error(`Unknown provider: ${provider}`);
  }
  const engine = new InfraEngine({ adapters, store, traceDirectory: resolve(directory, 'traces'),
    ...(options.has('--max-concurrency') ? { maxConcurrency: Number(options.get('--max-concurrency')) } : {}) });
  const prune = command === 'destroy' || options.has('--prune');
  if (command === 'destroy') {
    const saved = await store.load(stack.name);
    stack = cleanupStack(stack, saved);
  }
  if (command === 'plan') console.log(JSON.stringify(await engine.plan(stack, { prune }), null, 2));
  else {
    const result = await engine.apply(stack, { prune });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}

main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KubernetesAdapter, type CommandRunner, type KubernetesOptions,
} from '../src/providers/kubernetes.ts';
import type { JsonObject, ProviderContext, Resource } from '../src/types.ts';

const providerContext: ProviderContext = { stack: 'kubeconfig-review', operationId: 'operation' };
const resource: Resource = {
  id: 'settings', provider: 'kubernetes',
  spec: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'iac-test' }, data: { greeting: 'hello' } },
};
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('explicit kubeconfig requires a nonempty, bounded path without controls or flag-like values', () => {
  for (const kubeconfig of ['', '  ', 'a\0b', 'a\nb', 'a\rb', 'a\tb', '-other-flag', 'a'.repeat(4097), 123]) {
    assert.throws(() => new KubernetesAdapter({ context: 'local', kubeconfig } as KubernetesOptions), /kubeconfig/);
  }
  assert.doesNotThrow(() => new KubernetesAdapter({ context: 'local', kubeconfig: './config/cluster one.yaml' }));
});

test('kubeconfig is a command credential selector and does not change existing context/namespace scope identity', async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_command, args) => { calls.push([...args]); return { stdout: '' }; };
  const explicit = new KubernetesAdapter({ context: 'local', namespace: 'iac-test', kubeconfig: '/tmp/selected-config', runner });
  const alternate = new KubernetesAdapter({ context: 'local', namespace: 'iac-test', kubeconfig: '/tmp/rotated-config', runner });
  const implicit = new KubernetesAdapter({ context: 'local', namespace: 'iac-test', runner });
  assert.equal(explicit.scope, implicit.scope);
  assert.equal(alternate.scope, implicit.scope);
  await explicit.observe(resource, providerContext);
  await implicit.observe(resource, providerContext);
  assert.equal(calls[0]![calls[0]!.indexOf('--kubeconfig') + 1], '/tmp/selected-config');
  assert.equal(calls[1]!.includes('--kubeconfig'), false);
});

test('concurrent adapters keep every command bound to their captured kubeconfig and context without changing process environment', { timeout: 5000 }, async () => {
  const environment = process.env.KUBECONFIG;
  const release = deferred();
  function fixture(label: string) {
    const entered = deferred();
    const calls: Array<{ command: string; args: string[]; timeoutMs: number; kubeconfigEnvironment: string | undefined }> = [];
    let first = true;
    let live: JsonObject | undefined;
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args: [...args], timeoutMs: options.timeoutMs, kubeconfigEnvironment: process.env.KUBECONFIG });
      if (first && args.includes('get')) { first = false; entered.release(); await release.promise; }
      if (args.includes('get')) return { stdout: live ? JSON.stringify(live) : '' };
      if (args.includes('create') || args.includes('apply')) {
        live = JSON.parse(options.input!) as JsonObject;
        const metadata = live.metadata as JsonObject;
        metadata.uid = 'uid-' + label; metadata.resourceVersion = '7';
        return { stdout: JSON.stringify(live) };
      }
      if (args.includes('delete')) { live = undefined; return { stdout: '{}' }; }
      if (args.includes('wait')) return { stdout: 'condition met' };
      throw new Error('Unexpected fake command: ' + args.join(' '));
    };
    const selected: KubernetesOptions = {
      context: 'context-' + label, namespace: 'iac-test', kubeconfig: '/tmp/config-' + label,
      kubectl: 'kubectl-' + label, runner, timeoutMs: 2000,
    };
    const adapter = new KubernetesAdapter(selected);
    const work = async () => {
      await adapter.apply(resource, providerContext);
      await adapter.waitReady(resource, providerContext);
      const updated = structuredClone(resource);
      updated.spec.data = { greeting: 'updated' };
      await adapter.apply(updated, providerContext);
      await adapter.waitReady(updated, providerContext);
      await adapter.remove(updated, providerContext);
      assert.equal((await adapter.observe(updated, providerContext)).exists, false);
    };
    return { label, entered, calls, selected, work };
  }
  const a = fixture('a'), b = fixture('b');
  const work = Promise.all([a.work(), b.work()]);
  await Promise.all([a.entered.promise, b.entered.promise]);
  try {
    for (const fixture of [a, b]) {
      fixture.selected.context = 'changed-context';
      fixture.selected.namespace = 'changed-namespace';
      fixture.selected.kubeconfig = '/tmp/changed-config';
      fixture.selected.kubectl = 'changed-kubectl';
      fixture.selected.timeoutMs = 1;
      fixture.selected.runner = async () => { throw new Error('Caller replaced the runner'); };
    }
    assert.equal(process.env.KUBECONFIG, environment);
  } finally { release.release(); }
  await work;
  for (const fixture of [a, b]) {
    assert.ok(fixture.calls.length >= 9);
    for (const call of fixture.calls) {
      assert.equal(call.command, 'kubectl-' + fixture.label);
      assert.equal(call.args[call.args.indexOf('--context') + 1], 'context-' + fixture.label);
      assert.equal(call.args[call.args.indexOf('--kubeconfig') + 1], '/tmp/config-' + fixture.label);
      assert.equal(call.args[call.args.indexOf('--namespace') + 1], 'iac-test');
      assert.equal(call.timeoutMs, 3000);
      assert.equal(call.kubeconfigEnvironment, environment);
    }
    for (const verb of ['get', 'create', 'apply', 'delete', 'wait']) assert.ok(fixture.calls.some(call => call.args.includes(verb)), verb);
  }
  assert.equal(process.env.KUBECONFIG, environment);
});

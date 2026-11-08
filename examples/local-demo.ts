import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { InfraEngine, FileStateStore, SimulatorAdapter, backwalk, loadEvidence, replay, type Stack } from '../src/index.ts';
import assert from 'node:assert/strict';

await mkdir(resolve('.artifacts'), { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/demo-'));
const provider = new SimulatorAdapter({ file: join(directory, 'provider.json') });
const engine = new InfraEngine({ adapters: [provider], store: new FileStateStore(join(directory, 'state')) });
const stack: Stack = {
  name: 'local-demo', resources: [
    { id: 'network', provider: 'simulator', spec: { cidr: '10.42.0.0/24' } },
    { id: 'agent', provider: 'simulator', dependsOn: ['network'], spec: { image: 'neo:v1', replicas: 1 } },
  ],
};
provider.faults.loseResponseAfterApply = new Set(['network']);
const created = await engine.apply(stack);
assert.equal(created.ok, true);
assert.equal(provider.calls.filter(c => c.id === 'network').length, 1);
console.log('PASS create + lost response: reconciled without duplicate send');
const unchanged = await engine.plan(stack);
assert.ok(unchanged.operations.every(op => op.action === 'noop'));
console.log('PASS unchanged plan: all no-op');

stack.resources[1]!.spec.image = 'neo:v2';
provider.faults.failBeforeApply = new Set(['agent']);
const failed = await engine.apply(stack);
assert.equal(failed.ok, false);
const evidence = await loadEvidence(failed.evidencePath);
const explanation = backwalk(evidence);
assert.ok(explanation.text.includes('Reconcile agent'));
assert.deepEqual(replay(evidence).state, evidence.snapshot.sharedState);
await writeFile(join(directory, 'backwalk.txt'), explanation.text);
console.log('PASS failed update: retained resources, saved replayable failure evidence');
console.log(explanation.text);

provider.faults.failBeforeApply.clear();
assert.equal((await engine.apply(stack)).ok, true);
assert.ok((await engine.plan(stack)).operations.every(op => op.action === 'noop'));
console.log('PASS repair + rerun: converged');
console.log(`Evidence and provider fixture: ${directory}`);

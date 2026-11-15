import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lockNeoDeliveryTarget, type NeoDeliveryControl } from '../integration/identity/github-delivery/lock.ts';
import type { DeliveryState } from '../src/delivery/types.ts';

test('different delivery IDs share the whole local target lock and reject overlap before an inner delivery starts', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'iac-delivery-target-lock-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let began!: () => void, finish!: () => void, secondStarts = 0;
  const started = new Promise<void>(resolve => { began = resolve; }), mayFinish = new Promise<void>(resolve => { finish = resolve; });
  const state = (status: DeliveryState['status']) => ({ status } as DeliveryState);
  const first: NeoDeliveryControl = { async snapshot() { return state('idle'); }, subscribe() { return () => {}; },
    async start() { began(); await mayFinish; return state('passed'); } };
  const second: NeoDeliveryControl = { async snapshot() { return state('idle'); }, subscribe() { return () => {}; },
    async start() { secondStarts++; return state('passed'); } };
  const a = lockNeoDeliveryTarget(directory, first, async () => {}), b = lockNeoDeliveryTarget(directory, second, async () => {});
  const pending = a.start(); await started;
  await assert.rejects(b.start(), /locked|another process|already/i);
  assert.equal(secondStarts, 0);
  const independent = lockNeoDeliveryTarget(join(directory, 'another-target'), second, async () => {});
  assert.equal((await independent.start()).status, 'passed', 'unrelated targets remain independent');
  finish(); await pending;
  assert.equal((await b.start()).status, 'passed');
  assert.equal(secondStarts, 2);
});

test('a stale target is refused before a new delivery intent while completed reads remain effect-free', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'iac-delivery-target-stale-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let starts = 0, status: DeliveryState['status'] = 'idle';
  const workflow: NeoDeliveryControl = { async snapshot() { return { status } as DeliveryState; }, subscribe() { return () => {}; },
    async start() { starts++; return { status } as DeliveryState; } };
  const bound = lockNeoDeliveryTarget(directory, workflow, async () => { throw Error('Target changed'); });
  await assert.rejects(bound.start(), /Target changed/); assert.equal(starts, 0);
  status = 'passed'; assert.equal((await bound.start()).status, 'passed'); assert.equal(starts, 1);
});

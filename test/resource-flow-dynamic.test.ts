import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileResourceFlowStore, ResourceFlowWorkflow } from '../src/resource-flow/node.ts';
import type { ConnectionDetails, ResourceHandle } from '../src/resource-flow/index.ts';

test('a real dynamically assigned endpoint flows from Create into consumer configuration and authenticated verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'resource-flow-dynamic-'));
  const secret = randomBytes(24).toString('hex');
  let creates = 0, connects = 0, authenticatedRequests = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer ' + secret) { response.writeHead(401); response.end(); return; }
    authenticatedRequests++; response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ serviceId: 'generated-service', healthy: true }));
  });
  t.after(async () => {
    if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    await rm(directory, { recursive: true, force: true });
  });
  let endpoint: string | undefined;
  const handle = (): ResourceHandle => {
    assert.ok(server.listening && endpoint);
    return { id: 'history-service', kind: 'http-service', physicalId: 'generated-service:' + endpoint,
      scope: 'isolated-dynamic-http-service' };
  };
  const workflow = new ResourceFlowWorkflow({
    definition: { id: 'dynamic-service-flow', resourceId: 'history-service', label: 'Dynamic endpoint handoff', mode: 'create',
      target: { id: 'isolated-http', scope: 'isolated-dynamic-http-service' }, configurationDigest: 'b'.repeat(64) },
    store: new FileResourceFlowStore(directory), profiles: [{ id: 'history-profile', label: 'Generated service connection' }],
    adapters: {
      async create() {
        creates++; assert.equal(endpoint, undefined, 'the connection endpoint is unknown before provider creation');
        await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        endpoint = `http://127.0.0.1:${address.port}`;
        return handle();
      },
      async find() { return handle(); },
      async resolveDetails(resource): Promise<ConnectionDetails> {
        assert.equal(creates, 1); assert.equal(resource.physicalId, handle().physicalId);
        return { profileId: 'history-profile', resourceId: resource.id, endpoint: endpoint!, protocol: 'http', credentialRef: 'private-service-token' };
      },
      async validate(resource, details) {
        assert.equal(resource.physicalId, handle().physicalId);
        if (details) assert.equal(details.endpoint, endpoint);
      },
      async connect(_resource, details) {
        connects++;
        // The consumer receives the provider observation, never a guessed or preconfigured port.
        await writeFile(join(directory, 'consumer-config.json'), JSON.stringify({ endpoint: details.endpoint, credentialRef: details.credentialRef }));
        return { id: 'consumer-config-written' };
      },
      async verify() {
        const configuration = JSON.parse(await readFile(join(directory, 'consumer-config.json'), 'utf8')) as ConnectionDetails;
        assert.equal(configuration.credentialRef, 'private-service-token');
        const response = await fetch(configuration.endpoint, { headers: { authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(3000) });
        const body = await response.json() as { serviceId?: string; healthy?: boolean };
        const passed = response.status === 200 && body.serviceId === 'generated-service' && body.healthy === true;
        return { ok: passed, checks: [{ id: 'actual-authenticated-service-request', passed }] };
      },
    },
  });
  assert.equal(endpoint, undefined);
  const result = await workflow.start();
  assert.equal(result.status, 'passed'); assert.equal(creates, 1); assert.equal(connects, 1); assert.equal(authenticatedRequests, 1);
  assert.equal(result.details?.endpoint, endpoint); assert.equal(result.resource?.physicalId, handle().physicalId);
  assert.deepEqual(result.stages.map(stage => stage.status), ['passed', 'passed', 'passed', 'passed']);
  for (const file of (await readdir(directory)).filter(name => /\.jsonl?$/.test(name))) {
    assert.equal((await readFile(join(directory, file), 'utf8')).includes(secret), false, 'private authentication stays outside public state and native evidence');
  }
});

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function loopback(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', 'Use a local HTTP port-forward for this fixture.');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback trial endpoints are admitted.');
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  return url.origin;
}

export async function smoke(nodeUrl = 'http://127.0.0.1:15230', pythonUrl = 'http://127.0.0.1:18000') {
  const node = loopback(nodeUrl);
  const python = loopback(pythonUrl);
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `${new URL(url).pathname} returned HTTP ${response.status}`);
    return response;
  }
  const nodeHealth = await (await request(`${node}/health`)).json();
  assert.equal(nodeHealth.status, 'ok', 'Node backend must declare healthy.');
  const page = await request(`${node}/`);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/i);
  assert.match(await page.text(), /<html/i, 'The real app page must be served.');
  const pythonHealth = await (await request(`${python}/healthz`)).json();
  assert.equal(pythonHealth.status, 'ok');
  const result = await (await request(`${python}/tools/mds_get_switch_inventory`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ switch_name: 'SHCSANPLVSW901' }),
  })).json();
  assert.equal(result.af_provenance?.source, 'LOCAL SEED', 'A real seeded query must preserve its LOCAL SEED stamp.');
  assert.ok(Array.isArray(result.inventory), 'The real inventory query must return its declared rows.');
  assert.ok(result.inventory.some(row => row.switch === 'SHCSANPLVSW901'), 'The seeded switch must be present.');
  assert.ok(result.inventory.every(row => row.switch === 'SHCSANPLVSW901'), 'The real query must apply its switch filter.');
  return { passed: true, checks: ['node-health', 'app-html', 'python-health', 'seeded-real-query', 'seed-provenance', 'switch-filter'], scope: 'local fixture; no LLM conversation or live infrastructure query' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await smoke(process.argv[2], process.argv[3]), null, 2));
}

/** Fixed Node program: configuration is a JSON argv value, never executable text or a shell command. */
export const HTTP_CONNECTION_SCRIPT = String.raw`
const dns = require('node:dns/promises');
const request = JSON.parse(process.argv[1]);
const started = Date.now();
let stage = 'dns', finished = false, addresses = [], httpStatus = null;
// Preserve actual transport causes without recording response bodies, request headers or arbitrary error properties.
const describeError = (error, depth = 0, seen = new Set()) => {
  if (!error || typeof error !== 'object') return { message: String(error).slice(0, 500) };
  if (depth >= 4 || seen.has(error)) return { truncated: true };
  seen.add(error);
  const result = {};
  for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'address', 'port']) {
    const value = error[key];
    if (typeof value === 'string') result[key] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  if (error.cause !== undefined) result.cause = describeError(error.cause, depth + 1, seen);
  if (Array.isArray(error.errors)) {
    result.errors = error.errors.slice(0, 4).map(item => describeError(item, depth + 1, seen));
    if (error.errors.length > 4) result.errorsTruncated = true;
  }
  return result;
};
const finish = result => {
  if (finished) return; finished = true;
  process.stdout.write(JSON.stringify({ ...result, stage, addresses, httpStatus,
    latencyMs: Date.now() - started, observedAt: Date.now() }), () => process.exit(0));
};
const deadline = setTimeout(() => finish({ ok: false, error: 'Connection probe timed out' }), request.timeoutMs);
(async () => {
  addresses = (await dns.lookup(new URL(request.url).hostname, { all: true })).map(item => item.address).sort();
  if (!addresses.length || addresses.some(address => !request.clusterIPs.includes(address))) {
    throw new Error('Service DNS did not resolve only to its observed ClusterIP addresses');
  }
  stage = 'http';
  const response = await fetch(request.url, { signal: AbortSignal.timeout(request.timeoutMs), redirect: 'error' });
  httpStatus = response.status;
  if (httpStatus !== 200) throw new Error('HTTP health request returned ' + httpStatus);
  stage = 'response';
  let bytes = 0, chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 65536) throw new Error('Health response exceeded 64 KiB');
    chunks.push(Buffer.from(chunk));
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Health response was not valid JSON'); }
  if (body.status !== 'ok') throw new Error('Health response did not declare status ok');
  stage = 'complete'; finish({ ok: true, responseStatus: body.status });
})().catch(error => finish({ ok: false, error: String(error.message).slice(0, 500),
  transportError: describeError(error) })).finally(() => clearTimeout(deadline));
`;

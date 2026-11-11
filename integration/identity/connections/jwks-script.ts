/** Fixed in-Pod program. Only the admitted URL and deadline are JSON argv values. */
export const JWKS_CONNECTION_SCRIPT = String.raw`
const request = JSON.parse(process.argv[1]);
const { createPublicKey } = require('node:crypto');
const started = Date.now();
let httpStatus = null, finished = false;
const finish = (ok, code, signingKeys = 0) => {
  if (finished) return; finished = true;
  process.stdout.write(JSON.stringify({ ok, code, httpStatus, signingKeys,
    observedAt: Date.now(), latencyMs: Date.now() - started }), () => process.exit(0));
};
// Undici may retain a connection attempt after fetch aborts. Bound the child, not just the request.
const deadline = setTimeout(() => finish(false, 'jwks-deadline-exceeded'), request.timeoutMs);
(async () => {
  try {
    const response = await fetch(request.url, { redirect: 'error', signal: AbortSignal.timeout(request.timeoutMs) });
    httpStatus = response.status;
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel(); return finish(false, 'jwks-http-failed');
    }
    const reader = response.body?.getReader();
    if (!reader) return finish(false, 'jwks-response-invalid');
    const parts = []; let bytes = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) { await reader.cancel(); return finish(false, 'jwks-response-too-large'); }
      parts.push(Buffer.from(part.value));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { return finish(false, 'jwks-response-invalid'); }
    const keys = Array.isArray(body.keys) && body.keys.length <= 32 ? body.keys.filter(key => {
      if (!(key && key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256'
      && typeof key.kid === 'string' && key.kid.length > 0 && key.kid.length <= 256
      && typeof key.n === 'string' && key.n.length > 0 && typeof key.e === 'string' && key.e.length > 0)) return false;
      try { return createPublicKey({ key, format: 'jwk' }).asymmetricKeyDetails.modulusLength >= 2048; }
      catch { return false; }
    }) : [];
    return finish(keys.length > 0, keys.length ? 'verified' : 'jwks-signing-key-missing', keys.length);
  } catch { return finish(false, 'jwks-transport-failed'); }
})().catch(() => finish(false, 'jwks-probe-failed')).finally(() => clearTimeout(deadline));
`;

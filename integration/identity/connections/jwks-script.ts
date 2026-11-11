/** Fixed in-Pod program. DNS and the HTTP socket must agree with the freshly owned endpoint. */
export const JWKS_CONNECTION_SCRIPT = String.raw`
const request = JSON.parse(process.argv[1]);
const { createPublicKey } = require('node:crypto');
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');
const { get } = require('node:http');
const started = Date.now();
let httpStatus = null, finished = false, dnsAddresses = [], remoteAddress = null;
const finish = (ok, code, signingKeys = 0) => {
  if (finished) return; finished = true;
  process.stdout.write(JSON.stringify({ ok, code, httpStatus, signingKeys, dnsAddresses, remoteAddress,
    observedAt: Date.now(), latencyMs: Date.now() - started }), () => process.exit(0));
};
// A socket may retain a connection attempt. Bound the child, not just the request.
const timeoutMs = Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 10000 ? request.timeoutMs : 1000;
const deadline = setTimeout(() => finish(false, 'jwks-deadline-exceeded'), timeoutMs);
(async () => {
  try {
    let url;
    try { url = new URL(request.url); } catch { return finish(false, 'jwks-target-invalid'); }
    if (url.protocol !== 'http:' || url.username || url.password || url.hash || !url.hostname
      || isIP(request.expectedAddress) !== 4 || timeoutMs !== request.timeoutMs) return finish(false, 'jwks-target-invalid');
    let answers;
    try { answers = await lookup(url.hostname, { all: true, family: 4 }); }
    catch { return finish(false, 'jwks-dns-failed'); }
    dnsAddresses = [...new Set(answers.map(answer => answer.address))];
    if (!dnsAddresses.length || dnsAddresses.length > 8 || dnsAddresses.some(address => address !== request.expectedAddress)) {
      return finish(false, 'jwks-dns-unverified');
    }
    const bytes = await new Promise((accept, reject) => {
      // Keep the declared hostname/Host header, but prevent a second DNS answer from retargeting the socket.
      const operation = get(url, { family: 4, lookup: (_hostname, _options, callback) => callback(null, request.expectedAddress, 4) }, response => {
        httpStatus = response.statusCode; remoteAddress = response.socket.remoteAddress;
        if (remoteAddress !== request.expectedAddress) { response.destroy(); return finish(false, 'jwks-dns-unverified'); }
        if (httpStatus !== 200 || !response.headers['content-type']?.includes('application/json')) {
          response.destroy(); return finish(false, 'jwks-http-failed');
        }
        const parts = []; let length = 0;
        response.on('data', part => {
          length += part.length;
          if (length > 65536) { response.destroy(); return finish(false, 'jwks-response-too-large'); }
          parts.push(part);
        });
        response.once('end', () => accept(Buffer.concat(parts)));
        response.once('error', reject); response.once('aborted', () => reject(new Error('response-aborted')));
      });
      operation.once('error', reject);
    });
    let body;
    try { body = JSON.parse(bytes.toString('utf8')); }
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

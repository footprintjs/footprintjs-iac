import { request } from 'node:https';
import type { KubernetesReadonlyRunner } from './types.ts';

export interface KubernetesReadTlsOptions {
  server: string; ca: Buffer; cert?: Buffer; key?: Buffer; token?: (signal?: AbortSignal) => Promise<string | undefined>; timeoutMs: number;
}
async function credential(provider: KubernetesReadTlsOptions['token'], timeout: number): Promise<string | undefined> {
  if (!provider) return;
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => provider(abort.signal)), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(Error()); }, timeout);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
/** Separate from the dry-run client: this client has GET-only, finite registered readiness paths. */
export function createPinnedKubernetesReadonlyRunner(options: KubernetesReadTlsOptions, paths: readonly string[]): KubernetesReadonlyRunner {
  const server = new URL(options.server), allowed = new Set(paths);
  const fixed = { ...options, server: server.origin, ca: Buffer.from(options.ca),
    ...(options.cert ? { cert: Buffer.from(options.cert), key: Buffer.from(options.key!) } : {}) };
  return async path => {
    if (typeof path !== 'string' || !allowed.has(path) || !path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path)) throw Error('Kubernetes readiness request refused');
    try {
      const started = performance.now(), token = await credential(fixed.token, fixed.timeoutMs);
      const remaining = Math.floor(fixed.timeoutMs - (performance.now() - started));
      if (remaining < 1) throw Error();
      if (token !== undefined && (typeof token !== 'string' || !token || token.length > 8192 || /[\r\n]/.test(token))) throw Error();
      return await new Promise((resolve, reject) => {
        const req = request(new URL(path, fixed.server), { method: 'GET', ca: fixed.ca, cert: fixed.cert, key: fixed.key,
          rejectUnauthorized: true, signal: AbortSignal.timeout(remaining),
          headers: { Accept: path === '/readyz' ? 'text/plain' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
          const chunks: Buffer[] = []; let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) { response.destroy(); req.destroy(); reject(Error()); return; }
            chunks.push(Buffer.from(chunk));
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              const status = response.statusCode ?? 0, text = Buffer.concat(chunks).toString('utf8');
              // Non-200 bodies may contain broker/authentication details; discard them before this port returns.
              resolve({ status, body: status !== 200 ? null : path === '/readyz' ? text : JSON.parse(text) });
            } catch { reject(Error()); }
          });
        });
        req.once('error', reject); req.setTimeout(remaining, () => req.destroy()); req.end();
      });
    } catch { throw Error('Kubernetes readiness request unavailable'); }
  };
}

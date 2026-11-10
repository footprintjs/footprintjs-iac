/** Response bodies can contain credentials. Errors expose only a fixed reason and measured HTTP status. */
export class IdentityResponseError extends Error {
  readonly status: number;
  readonly code: 'invalid-response' | 'response-too-large' | 'response-read-failed';
  constructor(status: number, code: 'invalid-response' | 'response-too-large' | 'response-read-failed') {
    super(code === 'response-too-large' ? 'Identity response exceeded its byte limit'
      : code === 'response-read-failed' ? 'Identity response could not be read' : 'Identity response was not a JSON object');
    this.name = 'IdentityResponseError'; this.status = status; this.code = code;
  }
}
async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel(); } catch { /* Cancellation cannot replace the bounded response error. */ }
}

/** Count bytes before decoding or parsing. Never buffer an unbounded response with response.text(). */
export async function readIdentityJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('Invalid identity response byte limit');
  const body = response.body;
  if (!body) throw new IdentityResponseError(response.status, 'invalid-response');
  const reader = body.getReader();
  try {
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType ?? '')) {
      await cancel(reader); throw new IdentityResponseError(response.status, 'invalid-response');
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      await cancel(reader); throw new IdentityResponseError(response.status, 'response-too-large');
    }
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maxBytes - size) {
        await cancel(reader); throw new IdentityResponseError(response.status, 'response-too-large');
      }
      if (next.value.byteLength) { size += next.value.byteLength; chunks.push(next.value); }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new IdentityResponseError(response.status, 'invalid-response'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new IdentityResponseError(response.status, 'invalid-response');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof IdentityResponseError) throw error;
    throw new IdentityResponseError(response.status, 'response-read-failed');
  } finally { reader.releaseLock(); }
}

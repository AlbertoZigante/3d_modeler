/**
 * api/http.js
 *
 * The transport under api/client.js, as a factory so it can be tested in plain node
 * (fake fetch, tiny timeouts) without Vite's import.meta.env.
 *
 * Guarantees:
 *   - every failure is an ApiError with a machine `code`:
 *       API codes     'invalid_api_key', 'unauthorized', 'invalid_token', 'token_expired', 'rate_limited',
 *                     'validation_error', 'payload_too_large', 'not_implemented', ...
 *       client codes  'timeout', 'unreachable', 'aborted', 'not_configured'
 *   - a caller-supplied AbortSignal cancels the request (also if it is ALREADY aborted)
 *   - the API's X-Rules-Version header is tracked; listeners fire when it CHANGES, so
 *     cached results computed under old rules can be dropped.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, cause, code, retryAfterS } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.cause = cause;
    this.retryAfterS = retryAfterS; // seconds, from the Retry-After header of a 429 / 503 (undefined if absent)
  }
}

/**
 * `getToken`: optional () => string | null | Promise<...>, called per request; a token is sent as
 * `Authorization: Bearer <token>` (per-user auth, API phase 11). Never cached here: the auth layer owns refresh.
 */
export function createHttp({ baseUrl = '', apiKey = '', timeoutMs = 20000, fetchImpl, getToken } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const enabled = base.length > 0;
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const listeners = new Set();
  let rulesVersion = null;

  function trackRulesVersion(response) {
    const seen = response.headers?.get?.('X-Rules-Version') ?? null;
    if (seen === null) return;
    const previous = rulesVersion;
    rulesVersion = seen;
    if (previous !== null && previous !== seen) listeners.forEach((cb) => cb(seen, previous));
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    if (!enabled) throw new ApiError('Backend not configured (VITE_API_URL is empty)', { code: 'not_configured' });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort);

    try {
      if (signal?.aborted) throw new ApiError(`API ${path} aborted`, { code: 'aborted' });
      const token = getToken ? await getToken() : null;
      const response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      trackRulesVersion(response);
      if (!response.ok) {
        let code;
        try { code = (await response.json())?.code; } catch { /* body is not JSON */ }
        // Messages stay English here; the UI layer translates them (src/i18n).
        const message = code === 'invalid_api_key'
          ? 'Invalid or missing API key'
          : `API ${method} ${path} failed (HTTP ${response.status})`;
        const retryAfter = Number(response.headers?.get?.('Retry-After'));
        throw new ApiError(message, {
          status: response.status, code, retryAfterS: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        });
      }
      return await response.json();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (timedOut) throw new ApiError(`API ${path} timed out`, { cause: err, code: 'timeout' });
      if (signal?.aborted || err?.name === 'AbortError') throw new ApiError(`API ${path} aborted`, { cause: err, code: 'aborted' });
      throw new ApiError(`API ${path} unreachable`, { cause: err, code: 'unreachable' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    enabled,
    request,
    getRulesVersion: () => rulesVersion,
    /** cb(newVersion, previousVersion); returns an unsubscribe function. */
    onRulesVersionChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

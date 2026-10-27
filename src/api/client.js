/**
 * api/client.js
 *
 * The ONLY place the modeller talks to the backend (repo: api).
 * Everything else imports the functions below — nothing else calls fetch()
 * for backend data.
 *
 * Config (Vite env, see .env.example):
 *   VITE_API_URL  base URL of the API. In `vite dev` defaults to
 *                 http://localhost:8000; in a production build it must be set
 *                 (otherwise `apiEnabled` is false and callers degrade).
 *   VITE_API_KEY  optional, sent as X-API-Key. NOT a secret (it ships in the
 *                 bundle) — only a coarse beta gate.
 *
 * `import.meta.env?.` (optional chaining) because the node test files in
 * /tests import modules that import this file, and plain node has no
 * import.meta.env.
 */
const env = import.meta.env ?? {};
const API_URL = String(env.VITE_API_URL ?? (env.DEV ? 'http://localhost:8000' : '')).replace(/\/+$/, '');
const API_KEY = env.VITE_API_KEY ?? '';
const TIMEOUT_MS = 20000;

export const apiEnabled = API_URL.length > 0;

export class ApiError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.cause = cause;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  if (!apiEnabled) throw new ApiError('Backend not configured (VITE_API_URL is empty)');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort());

  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiError(`API ${method} ${path} failed (HTTP ${response.status})`, { status: response.status });
    }
    return await response.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      err?.name === 'AbortError' ? `API ${path} timed out` : `API ${path} unreachable`,
      { cause: err }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** GET /v1/catalog/materials -> Material[] */
export function getMaterials(options) {
  return request('/v1/catalog/materials', options);
}

/** POST /v1/bom  { panels } -> { rows, materialSummary } */
export function postBom(panels, options) {
  return request('/v1/bom', { method: 'POST', body: { panels }, ...options });
}

/** POST /v1/nesting  { panels, options } -> { bom, results, summary } */
export function postNesting(panels, nestingOptions = {}, options) {
  return request('/v1/nesting', { method: 'POST', body: { panels, options: nestingOptions }, ...options });
}

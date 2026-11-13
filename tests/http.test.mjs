/**
 * tests/http.test.mjs — src/api/http.js transport (error codes, timeout, abort, rules version, API-down).
 * Run with: node tests/http.test.mjs
 */
import { ApiError, createHttp } from '../src/api/http.js';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('  FAIL:', name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
  json: async () => { if (body === undefined) throw new SyntaxError('not json'); return body; },
});
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
/** fetch that never answers but honours AbortSignal, like the real one. */
const hanging = (_url, { signal }) => new Promise((_, reject) =>
  signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

console.log('request shape');
{
  const seen = [];
  const http = createHttp({ baseUrl: 'http://api.test///', apiKey: 'k1', fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, { ok: 1 }); } });
  const out = await http.request('/v1/bom', { method: 'POST', body: { panels: [] } });
  check('returns parsed JSON', out.ok === 1);
  check('trailing slashes stripped from base url', seen[0].url === 'http://api.test/v1/bom');
  check('sends API key and JSON content type', seen[0].init.headers['X-API-Key'] === 'k1' && seen[0].init.headers['Content-Type'] === 'application/json');
  check('serialises the body', seen[0].init.body === '{"panels":[]}');
  await http.request('/v1/version');
  check('GET without body has no content type', !('Content-Type' in seen[1].init.headers) && seen[1].init.body === undefined);
}

console.log('not configured (production build without VITE_API_URL)');
{
  const http = createHttp({ baseUrl: '' });
  const e = await rejects(http.request('/v1/bom'));
  check('enabled is false', http.enabled === false);
  check("ApiError code 'not_configured'", e instanceof ApiError && e.code === 'not_configured');
}

console.log('HTTP errors keep the stable API code');
{
  const mk = (status, body) => createHttp({ baseUrl: 'http://x', fetchImpl: async () => json(status, body) });
  let e = await rejects(mk(401, { code: 'invalid_api_key', detail: 'x' }).request('/v1/bom'));
  check('401 -> invalid_api_key + friendly message', e.code === 'invalid_api_key' && e.status === 401 && e.message === 'Invalid or missing API key');
  e = await rejects(mk(422, { code: 'validation_error', detail: [] }).request('/v1/bom'));
  check('422 -> validation_error', e.code === 'validation_error' && e.status === 422);
  e = await rejects(mk(413, { code: 'payload_too_large' }).request('/v1/bom'));
  check('413 -> payload_too_large', e.code === 'payload_too_large');
  e = await rejects(mk(501, { code: 'not_implemented' }).request('/v1/joints'));
  check('501 -> not_implemented', e.code === 'not_implemented');
  e = await rejects(mk(502, undefined).request('/v1/bom'));
  check('non-JSON error body -> ApiError without code', e instanceof ApiError && e.code === undefined && e.status === 502);
}

console.log('API DOWN');
{
  const http = createHttp({ baseUrl: 'http://x', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const e = await rejects(http.request('/v1/bom'));
  check("network failure -> code 'unreachable'", e instanceof ApiError && e.code === 'unreachable' && e.cause instanceof TypeError);
}

console.log('timeout');
{
  const http = createHttp({ baseUrl: 'http://x', timeoutMs: 20, fetchImpl: hanging });
  const t0 = Date.now();
  const e = await rejects(http.request('/v1/bom'));
  check("hanging request -> code 'timeout'", e instanceof ApiError && e.code === 'timeout');
  check('fails fast (not stuck)', Date.now() - t0 < 500);
}

console.log('caller abort');
{
  const http = createHttp({ baseUrl: 'http://x', timeoutMs: 5000, fetchImpl: hanging });
  const c = new AbortController();
  const p = rejects(http.request('/v1/bom', { signal: c.signal }));
  await sleep(5); c.abort();
  const e = await p;
  check("abort while in flight -> code 'aborted'", e instanceof ApiError && e.code === 'aborted');
  const pre = new AbortController(); pre.abort();
  const e2 = await rejects(http.request('/v1/bom', { signal: pre.signal }));
  check("already-aborted signal -> 'aborted' without hanging", e2 instanceof ApiError && e2.code === 'aborted');
}

console.log('X-Rules-Version tracking');
{
  let version = '0.1.0';
  const http = createHttp({ baseUrl: 'http://x', fetchImpl: async () => json(200, {}, { 'X-Rules-Version': version }) });
  const events = [];
  const off = http.onRulesVersionChange((now, was) => events.push([now, was]));
  check('null before the first response', http.getRulesVersion() === null);
  await http.request('/a');
  check('learns the version', http.getRulesVersion() === '0.1.0');
  check('first sighting is not a change', events.length === 0);
  await http.request('/a');
  check('same version -> no event', events.length === 0);
  version = '0.2.0'; await http.request('/a');
  check('changed version -> event(new, old)', events.length === 1 && events[0][0] === '0.2.0' && events[0][1] === '0.1.0');
  off(); version = '0.3.0'; await http.request('/a');
  check('unsubscribe works', events.length === 1 && http.getRulesVersion() === '0.3.0');
  const err = createHttp({ baseUrl: 'http://x', fetchImpl: async () => json(500, { code: 'x' }, { 'X-Rules-Version': '9' }) });
  await rejects(err.request('/a'));
  check('version is tracked on error responses too', err.getRulesVersion() === '9');
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);

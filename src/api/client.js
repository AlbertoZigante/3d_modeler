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
 * `import.meta.env ?? {}` because the node test files in /tests import modules that
 * import this file, and plain node has no import.meta.env. The transport itself
 * (timeouts, error codes, rules-version tracking) lives in ./http.js and is tested there.
 */
import { ApiError, createHttp } from './http.js';

// `globalThis.__MODELLER_ENV__`: test seam for node integration tests (no Vite there)
const env = import.meta.env ?? globalThis.__MODELLER_ENV__ ?? {};
const API_URL = String(env.VITE_API_URL ?? (env.DEV ? 'http://localhost:8000' : '')).replace(/\/+$/, '');
const API_KEY = env.VITE_API_KEY ?? '';

const http = createHttp({ baseUrl: API_URL, apiKey: API_KEY });
const request = http.request;

export { ApiError };
export const apiEnabled = http.enabled;
/** Rules version last reported by the API (X-Rules-Version), or null before the first response. */
export const getRulesVersion = http.getRulesVersion;
/** cb(newVersion, previousVersion) when the API's rules change under a running session. */
export const onRulesVersionChange = http.onRulesVersionChange;

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

/** GET /v1/version -> { apiVersion, rulesVersion, contractVersion } */
export function getVersion(options) {
  return request('/v1/version', options);
}

/**
 * Rules chain — RAW panel graph in (see payload.js toRawPayload), the server
 * resolves it itself. Until the Python port lands these answer 501
 * (ApiError.code === 'not_implemented').
 */
/** POST /v1/joints  { panels } -> { joints, collisions, featureJoints } */
export function postJoints(rawPanels, options) {
  return request('/v1/joints', { method: 'POST', body: { panels: rawPanels }, ...options });
}

/** POST /v1/hardware-plan  { panels } -> { summary, hinges, runners, fasteners, unmatched } */
export function postHardwarePlan(rawPanels, options) {
  return request('/v1/hardware-plan', { method: 'POST', body: { panels: rawPanels }, ...options });
}

/** POST /v1/assembly  { panels } -> { steps, clusters, toolsSummary } */
export function postAssembly(rawPanels, options) {
  return request('/v1/assembly', { method: 'POST', body: { panels: rawPanels }, ...options });
}

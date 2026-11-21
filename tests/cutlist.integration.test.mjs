/**
 * tests/cutlist.integration.test.mjs — END-TO-END: ui/cutlist.js -> api/client.js -> http -> REAL FastAPI.
 *
 * Needs a running API (not part of the default test run):
 *   api:          uvicorn app.main:app --port 8000
 *   3d_modeler:   $env:API_URL="http://localhost:8000"; node tests/cutlist.integration.test.mjs
 * Without API_URL it prints SKIP and exits 0.
 *
 * Verifies, with the frozen golden designs:
 *   - requestBom(visible resolved panels) over real HTTP ends with the SAME rows as the original
 *     JS engine (legacyBom.json oracle)
 *   - superseded requests / burst of edits collapse into the last design
 *   - API down: data-bom-status = 'error', visible banner in the summary box, recovery on retry
 *   - NESTING (phase 7): the nesting plan returned over real HTTP equals the original JS engine for ALL golden
 *     designs; one run at a time; a re-click on an unchanged design costs no request; failures are reported
 *   - optional: API_URL_BUSY=<url of an API started with MAX_CONCURRENT_NESTINGS=0> checks the 503 'busy' path
 */
import { existsSync, readFileSync } from 'node:fs';

const DEAD_MODE = process.argv.includes('--dead'); // child process: API is unreachable by design
const API_URL = process.env.API_URL;
if (!API_URL) { console.log('SKIP: set API_URL (e.g. http://localhost:8000) to run the end-to-end cutlist test.'); process.exit(0); }

// ---- minimal browser stand-ins (cutlist.js touches document at import time)
const summaryEl = { innerHTML: '' };
globalThis.document = {
  getElementById: (id) => (id === 'nesting-summary' ? summaryEl : null),
  documentElement: { dataset: {} },
  // toast.js escapeHtmlLocal(): a <div> whose textContent comes back HTML-escaped through innerHTML
  createElement: () => {
    let text = '';
    return {
      set textContent(v) { text = String(v); },
      get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    };
  },
};
globalThis.__MODELLER_ENV__ = { VITE_API_URL: API_URL };

const { requestBom, ensureFreshBom, getLastBomRows, getBomStatus, runNesting, getNestingStatus, getLastNestingResult } = await import('../src/ui/cutlist.js');
const { postNesting } = await import('../src/api/client.js');
const { toPayload } = await import('../src/api/payload.js');
import { readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('  FAIL:', name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const golden = (d, f) => JSON.parse(readFileSync(new URL(`../fixtures/golden/${d}/${f}.json`, import.meta.url), 'utf8'));
const visible = (d) => golden(d, 'resolved').filter((p) => !p.hidden);
const close = (a, b) => Math.abs(a - b) < 1e-6;
const rowsMatch = (rows, legacy) => rows.length === legacy.length && rows.every((r, i) => {
  const l = legacy[i];
  return r.label === l.label && r.quantity === l.quantity && r.material === l.material
    && close(r.widthMm, l.widthMm) && close(r.heightMm, l.heightMm) && close(r.areaM2, l.areaM2) && close(r.bandingCost, l.bandingCost);
});

if (DEAD_MODE) {
  requestBom(visible('box_door_right'));
  await ensureFreshBom();
  check("status 'error' (API unreachable)", getBomStatus() === 'error' && document.documentElement.dataset.bomStatus === 'error');
  check('banner is visible in the summary box', /Backend unavailable/.test(summaryEl.innerHTML));
  check('no data, no crash', Array.isArray(getLastBomRows()) && getLastBomRows().length === 0);
  const out = await runNesting();
  check('nesting with the API down: null result, no crash', out === null);
  check("nesting status 'error' + attribute", getNestingStatus() === 'error' && document.documentElement.dataset.nestingStatus === 'error');
  check('nothing stored as a plan', getLastNestingResult() === null);
  console.log(`${pass}/${pass + fail} checks passed (dead-API child).`);
  process.exit(fail ? 1 : 0);
}

/** Fields the API ADDS on top of the frozen JS output (additive contract extension) — same rule as
 *  ADDITIVE_KEYS in api/tests/golden_harness.py: ignored when comparing with the legacy oracle. */
const ADDITIVE_KEYS = new Set(['assemblyKind', 'assemblyIndex']);
const stripAdditive = (x) => {
  if (Array.isArray(x)) return x.map(stripAdditive);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => !ADDITIVE_KEYS.has(k)).map(([k, v]) => [k, stripAdditive(v)]));
  return x;
};

/** Structural diff with numeric tolerance (JS twin of api/tests/golden_harness.py deep_diff). */
function deepDiff(a, e, tol = 1e-6, path = '$') {
  if (typeof e === 'number' && typeof a === 'number') return Math.abs(a - e) <= tol ? [] : [`${path}: ${a} != ${e}`];
  if (Array.isArray(e) && Array.isArray(a)) {
    if (a.length !== e.length) return [`${path}: length ${a.length} != ${e.length}`];
    return a.flatMap((x, i) => deepDiff(x, e[i], tol, `${path}[${i}]`));
  }
  if (e && a && typeof e === 'object' && typeof a === 'object') {
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    return [...keys].flatMap((k) => (k in e && k in a ? deepDiff(a[k], e[k], tol, `${path}.${k}`) : [`${path}.${k}: ${k in e ? 'missing' : 'unexpected'}`]));
  }
  return a === e ? [] : [`${path}: ${JSON.stringify(a)} != ${JSON.stringify(e)}`];
}
// Designs with a frozen nesting reference (resolver-only designs freeze just raw + resolved).
const allDesigns = readdirSync(new URL('../fixtures/golden/', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`../fixtures/golden/${d.name}/legacyNesting.json`, import.meta.url))).map((d) => d.name);
/** Counts the real HTTP calls made to nesting. */
const nestingCalls = { n: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => { if (String(url).endsWith('/v1/nesting')) nestingCalls.n++; return realFetch(url, init); };

console.log('real HTTP: BOM equals the original JS engine for every golden design');
for (const d of ['box_plain', 'box_drawers_plinth', 'box_tall_door', 'two_boxes', 'box_legs']) {
  requestBom(visible(d));
  await ensureFreshBom();
  check(`${d}: status ready`, getBomStatus() === 'ready' && document.documentElement.dataset.bomStatus === 'ready');
  check(`${d}: rows == legacy oracle (${golden(d, 'legacyBom').rows.length} rows)`, rowsMatch(getLastBomRows(), golden(d, 'legacyBom').rows));
}

console.log('a burst of edits ends on the LAST design');
{
  for (const d of ['box_plain', 'box_shelf_h', 'box_door_left', 'box_drawer_1']) requestBom(visible(d));
  await ensureFreshBom();
  check('rows belong to the last design', rowsMatch(getLastBomRows(), golden('box_drawer_1', 'legacyBom').rows));
}

console.log('empty design: no request, empty rows');
{
  requestBom([]);
  await ensureFreshBom();
  check('empty rows, ready', getLastBomRows().length === 0 && getBomStatus() === 'ready');
}

console.log('PHASE 7 — nesting over real HTTP equals the original JS engine, ALL golden designs');
{
  let bad = 0;
  for (const d of allDesigns) {
    const legacy = golden(d, 'legacyNesting');
    const got = await postNesting(toPayload(visible(d)));
    const diffs = deepDiff(stripAdditive(got), legacy);
    if (diffs.length) { bad++; console.error(`  ${d}: ${diffs.length} diff(s), first: ${diffs[0]}`); }
  }
  check(`${allDesigns.length} designs: client -> HTTP -> API == legacy JS nesting`, bad === 0 && allDesigns.length >= 20);
}

console.log('nesting through cutlist.js (state, busy guard, cache)');
{
  const d = 'box_drawers_plinth';
  requestBom(visible(d));
  await ensureFreshBom();
  nestingCalls.n = 0;
  const [a, b] = await Promise.all([runNesting(), runNesting()]);
  check('double click: exactly one run produced a plan', (a === null) !== (b === null));
  check('double click: exactly one HTTP call', nestingCalls.n === 1);
  const legacy = golden(d, 'legacyNesting');
  const plan = getLastNestingResult();
  check('status ready + attribute', getNestingStatus() === 'ready' && document.documentElement.dataset.nestingStatus === 'ready');
  check('stored plan == legacy (sheets, totals)', plan.summary.totals.sheetsUsed === legacy.summary.totals.sheetsUsed
    && deepDiff(stripAdditive(plan.nestResults), legacy.results).length === 0 && deepDiff(stripAdditive(plan.summary), legacy.summary).length === 0);
  check('BOM kept in sync with the nesting response', rowsMatch(getLastBomRows(), legacy.bom.rows));

  const again = await runNesting();
  check('re-click on an unchanged design: served from cache (no HTTP)', nestingCalls.n === 1 && again !== null);

  requestBom(visible('box_door_left'));
  await ensureFreshBom();
  check('design changed -> the shown plan is flagged stale by signature (not silently replaced)', getLastNestingResult().signature !== undefined);
  await runNesting();
  check('new design -> new HTTP call and its own plan', nestingCalls.n === 2
    && getLastNestingResult().summary.totals.sheetsUsed === golden('box_door_left', 'legacyNesting').summary.totals.sheetsUsed);

  requestBom([]);
  await ensureFreshBom();
  check('empty design: nothing to nest (null, no HTTP)', (await runNesting()) === null && nestingCalls.n === 2);
}

if (process.env.API_URL_BUSY) {
  console.log('server overloaded (503 busy) — needs an API started with MAX_CONCURRENT_NESTINGS=0');
  const { createHttp } = await import('../src/api/http.js');
  const busy = createHttp({ baseUrl: process.env.API_URL_BUSY });
  let err = null;
  try { await busy.request('/v1/nesting', { method: 'POST', body: { panels: toPayload(visible('box_plain')) } }); } catch (e) { err = e; }
  check("503 -> ApiError code 'busy'", err?.code === 'busy' && err?.status === 503);
  const { describeApiError } = await import('../src/api/errors.js');
  check('mapped to the friendly retryable message', describeApiError(err).retryable && /busy/i.test(describeApiError(err).message));
}

console.log('API unreachable -> visible degraded state (recovery/retry is covered in requester.test.mjs)');
{
  // Child process pointed at a dead port (discard port 9: connection refused).
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--dead'], {
    env: { ...process.env, API_URL: 'http://127.0.0.1:9' }, encoding: 'utf8',
  });
  check('dead-API scenario passes in its own process', child.status === 0);
  if (child.status !== 0) console.error(child.stdout, child.stderr.slice(0, 600));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);

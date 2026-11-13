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
 */
import { readFileSync } from 'node:fs';

const DEAD_MODE = process.argv.includes('--dead'); // child process: API is unreachable by design
const API_URL = process.env.API_URL;
if (!API_URL) { console.log('SKIP: set API_URL (e.g. http://localhost:8000) to run the end-to-end cutlist test.'); process.exit(0); }

// ---- minimal browser stand-ins (cutlist.js touches document at import time)
const summaryEl = { innerHTML: '' };
globalThis.document = {
  getElementById: (id) => (id === 'nesting-summary' ? summaryEl : null),
  documentElement: { dataset: {} },
};
globalThis.__MODELLER_ENV__ = { VITE_API_URL: API_URL };

const { requestBom, ensureFreshBom, getLastBomRows, getBomStatus } = await import('../src/ui/cutlist.js');

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
  console.log(`${pass}/${pass + fail} checks passed (dead-API child).`);
  process.exit(fail ? 1 : 0);
}

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

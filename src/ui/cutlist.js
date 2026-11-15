/**
 * ui/cutlist.js
 *
 * Owns the "last computed BOM / nesting result" state — the same
 * treatment modeller/selection.js already gives selection state:
 * genuinely separate from the panels graph, so it gets its own small
 * module instead of living as loose variables in modeller-main.js.
 *
 * BOM and nesting are computed by the BACKEND (repo: api — POST /v1/bom,
 * POST /v1/nesting). The modeller sends RESOLVED panels (the same
 * resolveConstraints output feeding the 3D/2D views); this file keeps the
 * latest result for the PDF exports and the nesting-staleness banner.
 * Debounce / cache / abort-stale / error state live in api/requester.js
 * (unit-tested); this file only wires it to the DOM.
 *
 * There is deliberately NO local JS fallback: the original BOM/nesting engines
 * are kept only as test oracles (scripts/golden/legacy). If the API is down the
 * cut list shows a visible error state and exports retry on demand.
 *
 * modeller-main.js calls requestBom(visiblePanels) once per renderAll().
 * Nothing here blocks rendering: the cut list is only consumed by the
 * export buttons and the nesting banner, so a ~300ms lag is invisible.
 */
import { exportCutListPdf, exportNestingPdf } from '../engine/pdfExport-bom.js';
import { onRulesVersionChange, postBom, postNesting } from '../api/client.js';
import { toPayload } from '../api/payload.js';
import { STALE_NOTE, describeApiError } from '../api/errors.js';
import { createLatestRequester } from '../api/requester.js';
import { escapeHtmlLocal, showToast } from './toast.js';

const nestingSummaryEl = document.getElementById('nesting-summary');
const nestButtonEl = document.getElementById('topbar-nest-cutlist-btn');
const BOM_DEBOUNCE_MS = 300;

// BOM: "latest design wins" requester (debounce, LRU cache, abort of superseded calls, error state).
const bom = createLatestRequester({
  call: (payload, { signal }) => postBom(payload, { signal }),
  emptyResult: { rows: [] },
  debounceMs: BOM_DEBOUNCE_MS,
  onChange: onBomStateChange,
});
// Nesting: user-triggered ("Nest Cut List"), so no debounce — but the same requester gives it a small
// result cache (re-clicking on an unchanged design costs no request), an error state, and invalidation
// when the API's rules change. Its response carries the BOM of the same payload (kept in sync below).
const nesting = createLatestRequester({
  call: (payload, { signal }) => postNesting(payload, { signal }),
  debounceMs: 0,
  cacheSize: 4,
  onChange: onNestingStateChange,
});
let nestingBusy = false; // one nesting run at a time (a double click must not open two PDFs)
let lastToastCode = null; // one toast per distinct problem, not one per render

// Cached from the most recent "Nest Cut List" run — kept around so
// the inline summary/warning banner survives ordinary re-renders
// without re-nesting on every renderAll() (real packing work, done
// server-side). `signature` is a lightweight fingerprint of the BOM
// rows nesting was actually run against, so a later design change can
// be flagged as "stale" without needing to re-nest just to notice.
let lastNestingResult = null; // { nestResults, summary, signature } | null

function reportApiError(err) {
  console.error('Backend call failed:', err);
  const { code, message, silent } = describeApiError(err);
  if (silent || lastToastCode === code) return;
  lastToastCode = code;
  showToast(message);
}

// Reflects the BOM request state on <html data-bom-status="idle|loading|ready|error"> (CSS/tests can hook it)
// and in the sidebar summary box.
function onBomStateChange(state) {
  document.documentElement.dataset.bomStatus = state.status;
  if (state.status === 'error') reportApiError(state.error);
  if (state.status === 'ready') lastToastCode = null;
  if (state.status === 'ready' || state.status === 'error') renderNestingSummary();
}

// Reflects the nesting state on <html data-nesting-status=...> and keeps the button from being re-clicked mid-run.
function onNestingStateChange(state) {
  document.documentElement.dataset.nestingStatus = state.status;
  const busy = state.status === 'loading';
  if (nestButtonEl) {
    nestButtonEl.disabled = busy;
    nestButtonEl.setAttribute('aria-busy', String(busy));
  }
  if (state.status === 'ready') lastToastCode = null;
}

// Called from renderAll(). Cheap and synchronous; the network call is debounced.
export function requestBom(panels) {
  bom.request(toPayload(panels));
}

const flushBom = () => bom.flush();

// The API's rules changed under a running session (deploy): results computed before are stale.
onRulesVersionChange(() => {
  bom.invalidate();
  nesting.invalidate();
  lastNestingResult = null; // a plan computed under the old rules must not be shown or exported as current
  renderNestingSummary();
  flushBom();
});

export function getBomStatus() {
  return bom.getState().status;
}

export function getNestingStatus() {
  return nesting.getState().status;
}

export function getLastNestingResult() {
  return lastNestingResult;
}

const isBomFresh = () => bom.isFresh();

export function getLastBomRows() {
  return bom.getState().result?.rows ?? [];
}

// Resolves once lastBomRows matches the design on screen (or the API failed).
export async function ensureFreshBom() {
  await flushBom();
  return getLastBomRows();
}

// A tab opened synchronously inside the click handler, BEFORE any await,
// so the popup blocker still sees a user gesture. null if blocked.
function openPlaceholderWindow() {
  try {
    return window.open('', '_blank');
  } catch {
    return null;
  }
}

export async function openCutListWindow(newWindow = false) {
  const targetWindow = isBomFresh() ? null : openPlaceholderWindow();
  const rows = await ensureFreshBom();
  if (rows.length === 0) {
    targetWindow?.close();
    return;
  }
  exportCutListPdf(rows, { projectName: 'Cut List', mode: 'open', newWindow, targetWindow });
}

export async function exportBomPdf() {
  const rows = await ensureFreshBom();
  if (rows.length === 0) return;
  exportCutListPdf(rows, { projectName: 'Cut List' });
}

// Runs nesting for the design on screen and stores the result. Returns it, or null when there was nothing to
// do / another run is in progress / the call failed (the failure is reported to the person, not thrown).
// No DOM or window access beyond the toast, so it is testable end-to-end in node.
export async function runNesting() {
  const { payload } = bom.peek();
  if (!payload || payload.length === 0 || nestingBusy) return null;

  nestingBusy = true;
  try {
    nesting.request(payload);
    await nesting.flush();
    const state = nesting.getState();
    if (state.status === 'error') {
      reportApiError(state.error);
      return null;
    }
    if (state.status !== 'ready' || !nesting.isFresh()) return null; // superseded or invalidated meanwhile
    const { bom: nestedBom, results, summary } = state.result;
    // The nesting response carries the BOM of the same payload — keep both in sync.
    bom.seed(payload, { rows: nestedBom.rows });
    lastNestingResult = { nestResults: results, summary, signature: bomRowsSignature(nestedBom.rows) };
    renderNestingSummary();
    return lastNestingResult;
  } finally {
    nestingBusy = false;
  }
}

export async function openNestingPlan(newWindow = false) {
  if (nestingBusy) return; // already running: ignore the extra click (before opening a tab for it)
  const { payload } = bom.peek();
  if (!payload || payload.length === 0) return;

  const targetWindow = openPlaceholderWindow();
  const out = await runNesting();
  if (!out) {
    targetWindow?.close();
    return;
  }
  exportNestingPdf(out.nestResults, out.summary, { projectName: 'Nesting Plan', mode: 'open', newWindow, targetWindow });
}

export function renderNestingSummary() {
  if (!nestingSummaryEl) return;

  // Visible degraded state (not just a toast): the cut list can't refresh while the API is failing.
  let outage = '';
  if (bom.getState().status === 'error') {
    const { message, retryable } = describeApiError(bom.getState().error);
    outage = `<div class="warning-banner">${escapeHtmlLocal(message)}${retryable ? `<br>${escapeHtmlLocal(STALE_NOTE)}` : ''}</div>`;
  }

  if (!lastNestingResult) {
    nestingSummaryEl.innerHTML = outage;
    return;
  }

  const { summary, signature } = lastNestingResult;
  const stale = signature !== bomRowsSignature(getLastBomRows());
  const unplacedMaterials = summary.perMaterial.filter((m) => m.unplacedCount > 0);

  nestingSummaryEl.innerHTML = `
    ${outage}
    <div class="section-title">Nesting Plan</div>

    ${stale ? `
      <div class="warning-banner">
        Design changed since this was last nested — numbers below may be out of date. Re-run "Nest Cut List" to refresh.
      </div>
    ` : ''}

    <div style="font-size:12px; color:#3a3126; margin-bottom:12px; line-height:1.6;">
      ${summary.totals.sheetsUsed} sheet(s) &middot;
      ${(summary.totals.utilization * 100).toFixed(1)}% utilization
      ${summary.totals.totalCost > 0 ? ` &middot; ${summary.totals.totalCost.toFixed(2)} total` : ''}
    </div>

    ${unplacedMaterials.length > 0 ? `
      <div class="warning-banner">
        <strong>${summary.totals.unplacedCount} piece(s) don't fit any configured stock sheet:</strong>
        <br>
        ${unplacedMaterials
          .map((m) => `${escapeHtmlLocal(m.material)}: ${m.unplacedLabels.map(escapeHtmlLocal).join(', ')} (${m.unplacedCount} pc, ${m.unplacedAreaM2.toFixed(2)}m²)`)
          .join('<br>')}
      </div>
    ` : ''}
  `;
}

function bomRowsSignature(rows) {
  return rows.map((r) => `${r.label}|${r.material}|${r.thicknessMm}|${r.widthMm}|${r.heightMm}|${r.quantity}`).join(';');
}

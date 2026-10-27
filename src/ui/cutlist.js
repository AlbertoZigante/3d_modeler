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
 * resolveConstraints output feeding the 3D/2D views); this file only
 * debounces/caches the calls and keeps the latest result for the PDF
 * exports and the nesting-staleness banner.
 *
 * modeller-main.js calls requestBom(visiblePanels) once per renderAll().
 * Nothing here blocks rendering: the cut list is only consumed by the
 * export buttons and the nesting banner, so a ~300ms lag is invisible.
 */
import { exportCutListPdf, exportNestingPdf } from '../engine/pdfExport-bom.js';
import { postBom, postNesting } from '../api/client.js';
import { toPayload } from '../api/payload.js';
import { escapeHtmlLocal, showToast } from './toast.js';

const nestingSummaryEl = document.getElementById('nesting-summary');
const BOM_DEBOUNCE_MS = 300;

// Last BOM rows returned by the API for `appliedKey`. Read by the export
// buttons and by the nesting staleness check.
let lastBomRows = [];
let appliedKey = null;

// Newest design seen by requestBom() — what an export acts on.
let latest = { payload: [], key: '[]' };
let debounceTimer = null;
let inflight = null; // { key, promise }
let bomSeq = 0; // ignores out-of-order responses
let errorShown = false;

// Cached from the most recent "Nest Cut List" run — kept around so
// the inline summary/warning banner survives ordinary re-renders
// without re-nesting on every renderAll() (real packing work, done
// server-side). `signature` is a lightweight fingerprint of the BOM
// rows nesting was actually run against, so a later design change can
// be flagged as "stale" without needing to re-nest just to notice.
let lastNestingResult = null; // { nestResults, summary, signature } | null

function reportApiError(err) {
  console.error('Backend call failed:', err);
  if (errorShown) return; // one toast per outage, not one per render
  errorShown = true;
  showToast('Backend unavailable — cut list and nesting need the API.');
}

// Called from renderAll(). Cheap and synchronous; the network call is debounced.
export function requestBom(panels) {
  const payload = toPayload(panels);
  const key = JSON.stringify(payload);
  if (key === latest.key) return;
  latest = { payload, key };
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBom, BOM_DEBOUNCE_MS);
}

function flushBom() {
  clearTimeout(debounceTimer);
  const { payload, key } = latest;
  if (key === appliedKey) return Promise.resolve();
  if (inflight && inflight.key === key) return inflight.promise;
  if (payload.length === 0) {
    lastBomRows = [];
    appliedKey = key;
    renderNestingSummary();
    return Promise.resolve();
  }

  const seq = ++bomSeq;
  const promise = postBom(payload)
    .then(({ rows }) => {
      if (seq !== bomSeq) return; // a newer request superseded this one
      lastBomRows = rows;
      appliedKey = key;
      errorShown = false;
      renderNestingSummary();
    })
    .catch((err) => {
      if (seq === bomSeq) reportApiError(err);
    })
    .finally(() => {
      if (inflight && inflight.promise === promise) inflight = null;
    });
  inflight = { key, promise };
  return promise;
}

const isBomFresh = () => appliedKey === latest.key;

export function getLastBomRows() {
  return lastBomRows;
}

// Resolves once lastBomRows matches the design on screen (or the API failed).
export async function ensureFreshBom() {
  await flushBom();
  return lastBomRows;
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

export async function openNestingPlan(newWindow = false) {
  clearTimeout(debounceTimer);
  const { payload, key } = latest;
  if (payload.length === 0) return;

  const targetWindow = openPlaceholderWindow();
  try {
    const { bom, results, summary } = await postNesting(payload);
    // The nesting response carries the BOM of the same payload — keep both in sync.
    if (latest.key === key) {
      lastBomRows = bom.rows;
      appliedKey = key;
    }
    errorShown = false;
    lastNestingResult = { nestResults: results, summary, signature: bomRowsSignature(bom.rows) };
    renderNestingSummary();
    exportNestingPdf(results, summary, { projectName: 'Nesting Plan', mode: 'open', newWindow, targetWindow });
  } catch (err) {
    targetWindow?.close();
    reportApiError(err);
  }
}

export function renderNestingSummary() {
  if (!nestingSummaryEl) return;

  if (!lastNestingResult) {
    nestingSummaryEl.innerHTML = '';
    return;
  }

  const { summary, signature } = lastNestingResult;
  const stale = signature !== bomRowsSignature(lastBomRows);
  const unplacedMaterials = summary.perMaterial.filter((m) => m.unplacedCount > 0);

  nestingSummaryEl.innerHTML = `
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

import {exportCutListPdf, exportNestingPdf} from '../engine/pdfExport.js'
import {nestCutList, summarizeNestingResult} from '../engine/nesting.js'
import {MATERIAL_CATALOG} from '../modeller/modules.js'
import {escapeHtmlLocal} from './toast.js'

// state + accessors: setBomRows(rows), getLastBomRows()
// (replacing the current lastBomRows module-level variable)

export function openCutListWindow() {
  if (lastBomRows.length === 0) return;
  exportCutListPdf(lastBomRows, { projectName: 'Cut List', mode: 'open' });
}

export function openNestingPlan() {
  if (lastBomRows.length === 0) return;
  const nestResults = nestCutList(lastBomRows, MATERIAL_CATALOG, {});
  const summary = summarizeNestingResult(nestResults, MATERIAL_CATALOG);
  lastNestingResult = { nestResults, summary, signature: bomRowsSignature(lastBomRows) }; // <-- missing
  renderNestingSummary(); // <-- missing
  exportNestingPdf(nestResults, summary, { projectName: 'Nesting Plan', mode: 'open' });
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


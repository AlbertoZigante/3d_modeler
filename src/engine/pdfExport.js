import { jsPDF } from 'jspdf';

const PAGE_MARGIN_MM = 15;
const ROW_HEIGHT_MM = 7;
const HEADER_BLOCK_HEIGHT_MM = 18;

const COLUMNS = [
  { key: 'label', header: 'Piece', widthMm: 34 },
  { key: 'ids', header: 'ID', widthMm: 20 },
  { key: 'size', header: 'W × H (mm)', widthMm: 26, align: 'right' },
  { key: 'material', header: 'Material', widthMm: 30 },
  { key: 'thicknessMm', header: 'Thk', widthMm: 10, align: 'right' },
  { key: 'grain', header: 'Grain', widthMm: 14 },
  { key: 'edges', header: 'Edges', widthMm: 14 },
  { key: 'quantity', header: 'Qty', widthMm: 10, align: 'right' },
  { key: 'areaM2', header: 'm²', widthMm: 14, align: 'right' },
];

function formatDim(mm) {
  // return Number(mm.toFixed(1)).toString();   // If the mesure is 400.0 make it 400
  return mm.toFixed(1).toString();              // If the mesure is 400.0 make it 400.0
}

function rowCell(row, key) {
  if (key === 'size') return `${formatDim(row.widthMm)} × ${formatDim(row.heightMm)}`;
  if (key === 'areaM2') return row.areaM2.toFixed(3);
  if (key === 'grain') return row.grainInterchangeable ? 'Free' : 'Fixed';
  if (key === 'edges') return row.bandedEdgesLabel === '—' ? '—' : `${row.bandedEdgesLabel} (${formatDim(row.bandingLengthM)}m)`;
  if (key === 'ids') return row.pieceCodes.join(', ');
  return String(row[key] ?? '');
}

function drawRow(doc, startX, y, cells) {
  let x = startX;
  COLUMNS.forEach((col, i) => {
    const align = col.align === 'right' ? 'right' : 'left';
    doc.text(cells[i], align === 'right' ? x + col.widthMm - 1 : x + 1, y, { align });
    x += col.widthMm;
  });
}

/**
 * `mode: 'save'` (default) triggers a normal file download.
 * `mode: 'open'` opens the generated PDF in a new browser tab
 * instead — used by the toolbar's "Open Cut List" button, so the
 * person can look at it right away without a download prompt.
 * jsPDF's 'bloburl' output is synchronous, so this stays inside the
 * same click-handler call stack that triggered it — important
 * because window.open() called asynchronously (e.g. after an await)
 * gets silently blocked as a popup by most browsers.
 */
export function exportCutListPdf(rows, { projectName = 'Cut List', fileName = 'cut-list.pdf', mode = 'save' } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = COLUMNS.reduce((sum, c) => sum + c.widthMm, 0);
  const startX = PAGE_MARGIN_MM;
  let y = PAGE_MARGIN_MM;

  function drawPageHeader() {
    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.text(projectName, startX, y);
    y += 8;

    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.text(new Date().toLocaleString(), startX, y);
    y += 8;

    doc.setFont(undefined, 'bold');
    drawRow(doc, startX, y, COLUMNS.map((c) => c.header));
    y += 2;
    doc.setLineWidth(0.3);
    doc.line(startX, y, startX + usableWidth, y);
    y += HEADER_BLOCK_HEIGHT_MM - 16;
    doc.setFont(undefined, 'normal');
  }

  drawPageHeader();

  let totalAreaM2 = 0;
  rows.forEach((row) => {
    totalAreaM2 += row.areaM2;

    if (y + ROW_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
      doc.addPage();
      y = PAGE_MARGIN_MM;
      drawPageHeader();
    }

    drawRow(doc, startX, y, COLUMNS.map((c) => rowCell(row, c.key)));
    y += ROW_HEIGHT_MM;
  });

  y += 2;
  doc.setLineWidth(0.2);
  doc.line(startX, y, startX + usableWidth, y);
  y += 6;
  doc.setFont(undefined, 'bold');
  doc.text(`Total area: ${totalAreaM2.toFixed(3)} m²`, startX, y);

  if (mode === 'open') {
    window.open(doc.output('bloburl'), '_blank');
  } else {
    doc.save(fileName);
  }
}

// ---------------------------------------------------------------
// NESTING PLAN PDF — a summary page (per-material sheet counts,
// cost, utilization, and any pieces that couldn't be nested at all)
// followed by one page PER SHEET, each drawn to scale with every
// placed piece as a labeled rectangle. Reuses jsPDF's own rect/text
// drawing directly rather than a separate canvas/SVG UI surface —
// this IS the visual sheet-layout diagram, delivered as the PDF
// itself (roadmap "step 3 + step 4" combined into one deliverable).
//
// Kerf and edge-banding margin are NOT asked about here or anywhere
// upstream of this call — they're read automatically from
// MATERIAL_CATALOG by nestCutList (see engine/nesting.js's own KERF
// / EDGE BANDING TRIM MARGIN file-header notes) as supplier/material
// properties, never something the person using this button needs to
// know or set.
// ---------------------------------------------------------------

const SHEET_PAGE_MARGIN_MM = 15;
const PLACEMENT_LABEL_FONT_SIZE = 7;
const SUMMARY_COL_X = { material: 0, sheets: 78, utilization: 105, cost: 138, unplaced: 165 };

function drawNestingSummaryPage(doc, summary, projectName) {
  const startX = SHEET_PAGE_MARGIN_MM;
  const usableWidth = doc.internal.pageSize.getWidth() - SHEET_PAGE_MARGIN_MM * 2;
  let y = SHEET_PAGE_MARGIN_MM;

  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text(`${projectName} — Nesting Summary`, startX, y);
  y += 9;

  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.text(new Date().toLocaleString(), startX, y);
  y += 10;

  doc.setFont(undefined, 'bold');
  doc.setFontSize(10);
  doc.text('Material', startX + SUMMARY_COL_X.material, y);
  doc.text('Sheets', startX + SUMMARY_COL_X.sheets, y);
  doc.text('Utilization', startX + SUMMARY_COL_X.utilization, y);
  doc.text('Cost', startX + SUMMARY_COL_X.cost, y);
  doc.text('Unplaced', startX + SUMMARY_COL_X.unplaced, y);
  y += 2;
  doc.setLineWidth(0.3);
  doc.line(startX, y, startX + usableWidth, y);
  y += 6;

  doc.setFont(undefined, 'normal');
  summary.perMaterial.forEach((m) => {
    doc.text(`${m.material} (${m.thicknessMm}mm)`, startX + SUMMARY_COL_X.material, y);
    doc.text(String(m.sheetsUsed), startX + SUMMARY_COL_X.sheets, y);
    doc.text(`${(m.utilization * 100).toFixed(1)}%`, startX + SUMMARY_COL_X.utilization, y);
    doc.text(m.pricePerSheet > 0 ? m.totalCost.toFixed(2) : '—', startX + SUMMARY_COL_X.cost, y);
    doc.text(m.unplacedCount > 0 ? `${m.unplacedCount} pc` : '—', startX + SUMMARY_COL_X.unplaced, y);
    y += 7;
  });

  y += 3;
  doc.setLineWidth(0.2);
  doc.line(startX, y, startX + usableWidth, y);
  y += 7;
  doc.setFont(undefined, 'bold');
  doc.text(
    `Totals: ${summary.totals.sheetsUsed} sheet(s), ${(summary.totals.utilization * 100).toFixed(1)}% utilization` +
      (summary.totals.totalCost > 0 ? `, cost ${summary.totals.totalCost.toFixed(2)}` : ''),
    startX,
    y
  );
  y += 10;

  const unplacedMaterials = summary.perMaterial.filter((m) => m.unplacedCount > 0);
  if (unplacedMaterials.length > 0) {
    doc.setFont(undefined, 'bold');
    doc.setTextColor(180, 40, 20);
    doc.text('Could not be nested onto any configured stock sheet:', startX, y);
    y += 7;
    doc.setFont(undefined, 'normal');
    unplacedMaterials.forEach((m) => {
      doc.text(
        `- ${m.material}: ${m.unplacedLabels.join(', ')} (${m.unplacedCount} piece(s), ${m.unplacedAreaM2.toFixed(2)}m²)`,
        startX + 3,
        y
      );
      y += 6;
    });
    doc.setTextColor(0, 0, 0);
  }
}

function drawSheetPage(doc, materialLabel, sheet, sheetNumber, totalSheets) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const startX = SHEET_PAGE_MARGIN_MM;
  let y = SHEET_PAGE_MARGIN_MM;

  doc.setFontSize(13);
  doc.setFont(undefined, 'bold');
  doc.text(
    `${materialLabel} — Sheet ${sheetNumber} of ${totalSheets}`,
    startX,
    y
  );
  y += 6;

  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  doc.text(
    `${sheet.widthMm} × ${sheet.heightMm}mm — ${sheet.placements.length} piece(s) — ${(sheet.utilization * 100).toFixed(1)}% utilization`,
    startX,
    y
  );
  y += 8;

  // -------------------------------------------------------------
  // Draw the physical sheet vertically whenever that gives us
  // better use of the A4 page.
  //
  // The nesting coordinates remain unchanged. We only transform
  // the drawing coordinates on the PDF.
  // -------------------------------------------------------------

  const rotateSheet = sheet.widthMm > sheet.heightMm;

  const physicalWidth = rotateSheet ? sheet.heightMm : sheet.widthMm;
  const physicalHeight = rotateSheet ? sheet.widthMm : sheet.heightMm;

  const drawAreaTop = y;
  const drawAreaWidth = pageWidth - SHEET_PAGE_MARGIN_MM * 2;
  const drawAreaHeight =
    pageHeight - drawAreaTop - SHEET_PAGE_MARGIN_MM;

  const scale = Math.min(
    drawAreaWidth / physicalWidth,
    drawAreaHeight / physicalHeight
  );

  const sheetDrawWidth = physicalWidth * scale;
  const sheetDrawHeight = physicalHeight * scale;

  const originX =
    startX + (drawAreaWidth - sheetDrawWidth) / 2;

  const originY = drawAreaTop;

  doc.setLineWidth(0.4);
  doc.setDrawColor(60, 60, 60);

  // -------------------------------------------------------------
  // Draw sheet outline
  // -------------------------------------------------------------

  doc.rect(
    originX,
    originY,
    sheetDrawWidth,
    sheetDrawHeight
  );

  // -------------------------------------------------------------
  // Transform nesting coordinates.
  //
  // Original nesting coordinates:
  //   x = distance from left
  //   y = distance from top
  //
  // When rotated:
  //   newX = original Y
  //   newY = original sheet width - original X - piece width
  //
  // This rotates the entire nesting layout by 90 degrees.
  // -------------------------------------------------------------

  sheet.placements.forEach((p) => {
    let rx;
    let ry;
    let rw;
    let rh;

    if (rotateSheet) {
      // 90° clockwise rotation
      rx = originX + p.yMm * scale;
      ry =
        originY +
        (sheet.widthMm - p.xMm - p.widthMm) * scale;

      rw = p.heightMm * scale;
      rh = p.widthMm * scale;
    } else {
      // Normal orientation
      rx = originX + p.xMm * scale;
      ry = originY + p.yMm * scale;

      rw = p.widthMm * scale;
      rh = p.heightMm * scale;
    }

    doc.setFillColor(230, 215, 190);
    doc.setDrawColor(120, 95, 60);
    doc.setLineWidth(0.25);

    doc.rect(rx, ry, rw, rh, 'FD');

    // Keep labels inside the rotated piece.
    if (rw > 12 && rh > 8) {
      const idLabel =
        `${p.pieceId}${p.rotated ? ' (R)' : ''}`;

      const sizeLabel =
        `${formatDim(p.finishedWidthMm ?? p.widthMm)}×` +
        `${formatDim(p.finishedHeightMm ?? p.heightMm)}`;

      doc.setFontSize(PLACEMENT_LABEL_FONT_SIZE);
      doc.setTextColor(45, 35, 20);

      doc.text(
        idLabel,
        rx + rw / 2,
        ry + rh / 2 - 1,
        { align: 'center' }
      );

      doc.text(
        sizeLabel,
        rx + rw / 2,
        ry + rh / 2 + 3,
        { align: 'center' }
      );
    }
  });

  doc.setTextColor(0, 0, 0);
}

/**
 * @param {ReturnType<typeof import('../modeller/nesting.js').nestCutList>} nestResults
 * @param {ReturnType<typeof import('../modeller/nesting.js').summarizeNestingResult>} summary
 * @param {{projectName?:string, fileName?:string, mode?:'save'|'open'}} [options]
 */
export function exportNestingPdf(nestResults, summary, { projectName = 'Nesting Plan', fileName = 'nesting-plan.pdf', mode = 'save' } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  drawNestingSummaryPage(doc, summary, projectName);

  nestResults.forEach((result) => {
    const materialLabel = `${result.material} (${result.thicknessMm}mm)`;
    result.sheets.forEach((sheet, i) => {
      doc.addPage();
      drawSheetPage(doc, materialLabel, sheet, i + 1, result.sheets.length);
    });
  });

  if (mode === 'open') {
    window.open(doc.output('bloburl'), '_blank');
  } else {
    doc.save(fileName);
  }
}
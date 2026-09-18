import { jsPDF } from 'jspdf';
import { formatSummaryLines, formatAttentionLines, formatJointTableRow, formatFeatureJointTableRow } from './joints.js';
import { formatHardwareTableRow } from './hardware.js';
import { computeWorldHalfExtents } from '../modeller/modules.js';

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

function drawTableRow(doc, startX, y, columns, cells) {
  let x = startX;
  columns.forEach((col, i) => {
    const align = col.align === 'right' ? 'right' : 'left';
    doc.text(String(cells[i] ?? ''), align === 'right' ? x + col.widthMm - 1 : x + 1, y, { align });
    x += col.widthMm;
  });
}

function drawRow(doc, startX, y, cells) {
  drawTableRow(doc, startX, y, COLUMNS, cells);
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
// GENERIC "one line of text at a time" PDF — shared by the ACTIVITY
// HISTORY export below (see history/history.js#HistoryManager's own
// activityLog — a COMPLETE, never-trimmed record of every user action
// this session, distinct from the undo/redo stacks) and the JOINT
// REPORT export further down. Simple enough not to need drawRow's
// column layout: one line of text, top to bottom, paginated the same
// way exportCutListPdf's rows above are. Both callers only differ in
// their default title/filename and the "N thing(s)" wording under the
// title, so those are parameters rather than two near-duplicate
// pagination loops.
// ---------------------------------------------------------------

const TEXT_LINE_HEIGHT_MM = 6;

function renderLinesPdf(lines, { projectName, fileName, mode, countLabel, emptyMessage }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageHeight = doc.internal.pageSize.getHeight();
  const startX = PAGE_MARGIN_MM;
  let y = PAGE_MARGIN_MM;

  function drawPageHeader() {
    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.text(projectName, startX, y);
    y += 8;

    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.text(`Generated ${new Date().toLocaleString()} — ${countLabel}`, startX, y);
    y += 6;
    doc.setLineWidth(0.3);
    doc.line(startX, y, doc.internal.pageSize.getWidth() - PAGE_MARGIN_MM, y);
    y += 6;
  }

  drawPageHeader();

  doc.setFontSize(9);
  if (lines.length === 0) {
    doc.setFont(undefined, 'italic');
    doc.text(emptyMessage, startX, y);
  } else {
    lines.forEach((line) => {
      if (y + TEXT_LINE_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
        doc.addPage();
        y = PAGE_MARGIN_MM;
        drawPageHeader();
        doc.setFontSize(9);
      }
      doc.text(line, startX, y);
      y += TEXT_LINE_HEIGHT_MM;
    });
  }

  if (mode === 'open') {
    window.open(doc.output('bloburl'), '_blank');
  } else {
    doc.save(fileName);
  }
}

/**
 * @param {string[]} lines - pre-formatted text lines, oldest first —
 *   see history/history.js#HistoryManager.getActivityLogText(), the
 *   intended source (split on '\n' before calling this).
 * @param {{projectName?:string, fileName?:string, mode?:'save'|'open'}} [options]
 */
export function exportHistoryPdf(lines, { projectName = 'Activity History', fileName = 'activity-history.pdf', mode = 'save' } = {}) {
  renderLinesPdf(lines, {
    projectName, fileName, mode,
    countLabel: `${lines.length} action(s)`,
    emptyMessage: 'No actions recorded yet this session.',
  });
}

// ---------------------------------------------------------------
// JOINT REPORT PDF — a debug/verification view over
// engine/joints.js#detectJoints's current output for the whole
// design: a text summary/attention block (see
// engine/joints.js#formatSummaryLines / formatAttentionLines) followed
// by a real TABLE, one row per joint. This is a sanity-check tool, not
// a fabrication document the way the cut list / nesting PDFs are — its
// job is letting you cross-check detectJoints() against what you can
// see in the 3D view (does Left really only touch Top/Bottom/Back?
// does the shelf really read as t_butt, not corner_butt?).
// ---------------------------------------------------------------

const JOINTS_TABLE_COLUMNS = [
  { key: 'id', header: 'Joint ID', widthMm: 14 },
  { key: 'type', header: 'Type', widthMm: 18 },
  { key: 'panelA', header: 'Panel 1 ID', widthMm: 16 },
  { key: 'panelB', header: 'Panel 2 ID', widthMm: 16 },
  { key: 'axis', header: 'Axis', widthMm: 8 },
  { key: 'faces', header: 'Faces', widthMm: 18 },
  { key: 'gap', header: 'Gap (mm)', widthMm: 12, align: 'right' },
  { key: 'point1', header: 'Point 1 (x,y,z)', widthMm: 32, align: 'right' },
  { key: 'point2', header: 'Point 2 (x,y,z)', widthMm: 32, align: 'right' },
  { key: 'length', header: 'Length', widthMm: 14, align: 'right' },
];

const FEATURE_JOINTS_TABLE_COLUMNS = [
  { key: 'id', header: 'Joint ID', widthMm: 14 },
  { key: 'kind', header: 'Kind', widthMm: 24 },
  { key: 'panelA', header: 'Panel 1 ID', widthMm: 18 },
  { key: 'panelB', header: 'Panel 2 ID', widthMm: 18 },
  { key: 'side', header: 'Side', widthMm: 14 },
  { key: 'point1', header: 'Point 1 (x,y,z)', widthMm: 34, align: 'right' },
  { key: 'point2', header: 'Point 2 (x,y,z)', widthMm: 34, align: 'right' },
  { key: 'length', header: 'Length', widthMm: 14, align: 'right' },
];

const HARDWARE_TABLE_COLUMNS = [
  { key: 'id', header: 'Hardware ID', widthMm: 18 },
  { key: 'kind', header: 'Kind', widthMm: 16 },
  { key: 'panelA', header: 'Panel 1 ID', widthMm: 18 },
  { key: 'panelB', header: 'Panel 2 ID', widthMm: 18 },
  { key: 'hardware', header: 'Hardware', widthMm: 58 },
  { key: 'qty', header: 'Qty', widthMm: 12, align: 'right' },
  { key: 'detail', header: 'Detail', widthMm: 40, align: 'right' },
];

const TABLE_ROW_HEIGHT_MM = 6;

/**
 * @param {ReturnType<typeof import('./joints.js').buildJointsReport>} report
 * @param {ReturnType<typeof import('./hardware.js').buildHardwarePlan>} [hardwarePlan] - optional third table (hinges/runners/fasteners); omitted entirely when not supplied
 * @param {{projectName?:string, fileName?:string, mode?:'save'|'open'}} [options]
 */
export function exportJointsPdf(report, hardwarePlan, { projectName = 'Joint Report', fileName = 'joint-report.pdf', mode = 'save' } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const startX = PAGE_MARGIN_MM;
  const tableWidth = JOINTS_TABLE_COLUMNS.reduce((sum, c) => sum + c.widthMm, 0);
  let y = PAGE_MARGIN_MM;

  function drawTitleBlock() {
    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.text(projectName, startX, y);
    y += 8;
    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.text(`Generated ${new Date().toLocaleString()}`, startX, y);
    y += 6;
  }

  function drawTextBlock(lines) {
    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    lines.forEach((line) => {
      if (y + TEXT_LINE_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
        doc.addPage();
        y = PAGE_MARGIN_MM;
      }
      doc.text(line, startX, y);
      y += TEXT_LINE_HEIGHT_MM;
    });
  }

  function drawTableHeader(columns, width) {
    doc.setFontSize(7);
    doc.setFont(undefined, 'bold');
    drawTableRow(doc, startX, y, columns, columns.map((c) => c.header));
    y += 2;
    doc.setLineWidth(0.3);
    doc.line(startX, y, startX + width, y);
    y += 5;
    doc.setFont(undefined, 'normal');
  }

  drawTitleBlock();
  drawTextBlock(formatSummaryLines(report));
  const attentionLines = formatAttentionLines(report);
  if (attentionLines.length > 0) {
    y += 2;
    drawTextBlock(attentionLines);
  }

  y += 4;
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('All Joints', startX, y);
  y += 6;

  if (report.joints.length === 0) {
    doc.setFontSize(9);
    doc.setFont(undefined, 'italic');
    doc.text('No joints detected.', startX, y);
    y += TEXT_LINE_HEIGHT_MM;
  } else {
    drawTableHeader(JOINTS_TABLE_COLUMNS, tableWidth);
    doc.setFontSize(7);
    report.joints.forEach((j) => {
      if (y + TABLE_ROW_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
        doc.addPage();
        y = PAGE_MARGIN_MM;
        drawTableHeader(JOINTS_TABLE_COLUMNS, tableWidth);
      }
      const cells = formatJointTableRow(j);
      drawTableRow(doc, startX, y, JOINTS_TABLE_COLUMNS, JOINTS_TABLE_COLUMNS.map((c) => cells[c.key]));
      y += TABLE_ROW_HEIGHT_MM;
    });
  }

  // --- Second table: door hinges / drawer slides --------------------
  // A FeatureJoint isn't an AABB-contact joint at all (see
  // detectFeatureJoints's own doc comment — a drawer slide's two
  // panels typically don't even touch), so it gets its own, smaller
  // table rather than being forced into the joints table's contact-
  // specific columns (axis/faces/gap have no meaning here).
  const featureTableWidth = FEATURE_JOINTS_TABLE_COLUMNS.reduce((sum, c) => sum + c.widthMm, 0);
  if (report.featureJoints.length > 0) {
    y += 8;
    if (y + HEADER_BLOCK_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
      doc.addPage();
      y = PAGE_MARGIN_MM;
    }
    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    doc.text('Door Hinges / Drawer Slides', startX, y);
    y += 6;

    drawTableHeader(FEATURE_JOINTS_TABLE_COLUMNS, featureTableWidth);
    doc.setFontSize(7);
    report.featureJoints.forEach((j) => {
      if (y + TABLE_ROW_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
        doc.addPage();
        y = PAGE_MARGIN_MM;
        drawTableHeader(FEATURE_JOINTS_TABLE_COLUMNS, featureTableWidth);
      }
      const cells = formatFeatureJointTableRow(j);
      drawTableRow(doc, startX, y, FEATURE_JOINTS_TABLE_COLUMNS, FEATURE_JOINTS_TABLE_COLUMNS.map((c) => cells[c.key]));
      y += TABLE_ROW_HEIGHT_MM;
    });
  }

  // --- Third table: hardware (hinges / runners / fasteners) ---------
  // Only drawn when a hardwarePlan was actually supplied — a caller
  // that hasn't wired up engine/hardware.js yet, or a report with
  // nothing to recommend hardware for, gets the same two-table PDF as
  // before rather than an empty "Hardware" section.
  if (hardwarePlan) {
    const hardwareItems = [...hardwarePlan.hinges, ...hardwarePlan.runners, ...hardwarePlan.fasteners];
    const hardwareTableWidth = HARDWARE_TABLE_COLUMNS.reduce((sum, c) => sum + c.widthMm, 0);
    if (hardwareItems.length > 0) {
      y += 8;
      if (y + HEADER_BLOCK_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
        doc.addPage();
        y = PAGE_MARGIN_MM;
      }
      doc.setFontSize(11);
      doc.setFont(undefined, 'bold');
      doc.text('Hardware', startX, y);
      y += 6;
      doc.setFontSize(9);
      doc.setFont(undefined, 'normal');
      doc.text(
        `${hardwarePlan.summary.hingeCount} hinge joint(s) (${hardwarePlan.summary.totalHingeUnits} units), ` +
        `${hardwarePlan.summary.runnerCount} runner(s), ${hardwarePlan.summary.fastenerJointCount} fastener joint(s) ` +
        `(${hardwarePlan.summary.totalFastenerCount} fasteners), ${hardwarePlan.summary.unmatchedCount} unmatched`,
        startX, y
      );
      y += 6;

      drawTableHeader(HARDWARE_TABLE_COLUMNS, hardwareTableWidth);
      doc.setFontSize(7);
      hardwareItems.forEach((item) => {
        if (y + TABLE_ROW_HEIGHT_MM > pageHeight - PAGE_MARGIN_MM) {
          doc.addPage();
          y = PAGE_MARGIN_MM;
          drawTableHeader(HARDWARE_TABLE_COLUMNS, hardwareTableWidth);
        }
        const cells = formatHardwareTableRow(item);
        drawTableRow(doc, startX, y, HARDWARE_TABLE_COLUMNS, HARDWARE_TABLE_COLUMNS.map((c) => cells[c.key]));
        y += TABLE_ROW_HEIGHT_MM;
      });
    }
  }

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

// ---------------------------------------------------------------
// ASSEMBLY PLAN PDF — Option A: schematic line diagrams, one per
// step, in the style of a real flat-pack instruction booklet:
// already-placed panels drawn faint/grey, this step's new panel(s)
// drawn bold, a simple arrow showing where it goes, plus the
// step's own tools/hardware/ergonomics text underneath.
//
// DELIBERATELY NOT a photorealistic render (see the original plan's
// own "Option A vs Option B" split) — every panel is drawn as a plain
// wireframe box (12 edges, no shading/hidden-line removal) under a
// simple oblique ("cabinet") projection: depth (Z) is drawn receding
// at a fixed angle instead of vanishing to a perspective point. This
// is genuinely close to how real assembly diagrams are drawn, and —
// same reasoning as the joints/nesting diagrams already in this file
// — it's implementable with jsPDF's own line-drawing primitives
// directly, no separate rendering pipeline or 3D engine involved.
//
// The projection scale/origin is computed ONCE from the whole
// design's bounding box and reused for every step, so proportions
// stay consistent across the booklet — a panel is always the same
// size on the page whether it's introduced in step 2 or step 9,
// matching how a real instruction booklet never rescales between
// pages.
// ---------------------------------------------------------------

const OBLIQUE_ANGLE_RAD = Math.PI / 6; // 30° receding depth axis — a common "cabinet oblique" convention
const OBLIQUE_DEPTH_SCALE = 0.5; // depth foreshortened to 50% — keeps the drawing from reading as badly skewed

function projectOblique(point3d) {
  return {
    px: point3d.x + point3d.z * Math.cos(OBLIQUE_ANGLE_RAD) * OBLIQUE_DEPTH_SCALE,
    py: point3d.y + point3d.z * Math.sin(OBLIQUE_ANGLE_RAD) * OBLIQUE_DEPTH_SCALE,
  };
}

// The 8 corners of a resolved panel's own AABB, indexed 0-7 by the
// sign of (x,y,z) — bit0=x, bit1=y, bit2=z, 0=negative/1=positive.
// Keeping this bit-indexed (rather than an arbitrary corner order)
// is what makes edge generation below a one-liner instead of 12
// hand-written pairs.
function computeBoxCorners(resolvedPanel) {
  const half = computeWorldHalfExtents(resolvedPanel);
  const p = resolvedPanel.position;
  const corners = [];
  for (let i = 0; i < 8; i++) {
    corners.push({
      x: p.x + (i & 1 ? 1 : -1) * half.x,
      y: p.y + (i & 2 ? 1 : -1) * half.y,
      z: p.z + (i & 4 ? 1 : -1) * half.z,
    });
  }
  return corners;
}

// Every pair of corners whose bit-index differs by exactly one bit is
// a real cube edge — this generates all 12 without hardcoding them.
function boxEdges() {
  const edges = [];
  for (let i = 0; i < 8; i++) {
    for (let bit = 0; bit < 3; bit++) {
      const j = i ^ (1 << bit);
      if (j > i) edges.push([i, j]);
    }
  }
  return edges;
}
const BOX_EDGES = boxEdges();

/**
 * Computes the shared projection scale/bounds for the WHOLE design,
 * so every step's diagram uses the same scale (see file header).
 *
 * @param {Array} resolvedPanels
 * @returns {{minPx:number, maxPx:number, minPy:number, maxPy:number}}
 */
function computeSharedProjectionBounds(resolvedPanels) {
  let minPx = Infinity;
  let maxPx = -Infinity;
  let minPy = Infinity;
  let maxPy = -Infinity;
  resolvedPanels.filter((p) => !p.hidden).forEach((panel) => {
    computeBoxCorners(panel).forEach((corner) => {
      const { px, py } = projectOblique(corner);
      minPx = Math.min(minPx, px);
      maxPx = Math.max(maxPx, px);
      minPy = Math.min(minPy, py);
      maxPy = Math.max(maxPy, py);
    });
  });
  if (!Number.isFinite(minPx)) return { minPx: 0, maxPx: 1, minPy: 0, maxPy: 1 }; // no visible panels at all — degenerate but safe
  return { minPx, maxPx, minPy, maxPy };
}

// Maps one projected (px,py) point into PDF coordinates within a
// given diagram box (originX/Y, width/height), flipping Y since PDF
// grows downward while world/projected Y grows upward, and centering
// the (possibly non-square) projected bounds within the box.
function toDiagramXY(projectedPoint, bounds, box) {
  const spanPx = bounds.maxPx - bounds.minPx || 1;
  const spanPy = bounds.maxPy - bounds.minPy || 1;
  const scale = Math.min(box.width / spanPx, box.height / spanPy) * 0.85; // 15% padding inside the box
  const drawWidth = spanPx * scale;
  const drawHeight = spanPy * scale;
  const offsetX = box.x + (box.width - drawWidth) / 2;
  const offsetY = box.y + (box.height - drawHeight) / 2;
  return {
    x: offsetX + (projectedPoint.px - bounds.minPx) * scale,
    y: offsetY + (bounds.maxPy - projectedPoint.py) * scale,
  };
}

function drawPanelWireframe(doc, resolvedPanel, bounds, box, style) {
  const corners = computeBoxCorners(resolvedPanel).map((c) => toDiagramXY(projectOblique(c), bounds, box));
  doc.setDrawColor(...style.color);
  doc.setLineWidth(style.lineWidth);
  BOX_EDGES.forEach(([i, j]) => doc.line(corners[i].x, corners[i].y, corners[j].x, corners[j].y));
}

// A short, plain arrow (shaft + two-line arrowhead) from just outside
// the diagram box toward a panel's own projected center — enough to
// read as "this piece goes here" without a real vector-graphics
// arrowhead library.
function drawInsertionArrow(doc, targetResolvedPanel, bounds, box) {
  const centerProjected = projectOblique(targetResolvedPanel.position);
  const target = toDiagramXY(centerProjected, bounds, box);
  const start = { x: target.x - box.width * 0.28, y: target.y - box.height * 0.28 };

  doc.setDrawColor(200, 40, 40);
  doc.setLineWidth(0.5);
  doc.line(start.x, start.y, target.x, target.y);

  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 3.2;
  const headAngle = Math.PI / 7;
  [headAngle, -headAngle].forEach((a) => {
    const hx = ux * Math.cos(a) - uy * Math.sin(a);
    const hy = ux * Math.sin(a) + uy * Math.cos(a);
    doc.line(target.x, target.y, target.x - hx * headLen, target.y - hy * headLen);
  });
}

const DIAGRAM_BOX = { width: 130, height: 95 };
const ALREADY_PLACED_STYLE = { color: [180, 180, 180], lineWidth: 0.25 };
const NEW_PANEL_STYLE = { color: [20, 20, 20], lineWidth: 0.6 };

/**
 * Renders one step's diagram box: every panel placed up to (and
 * including) this step drawn faint, this step's own new panel(s)
 * drawn bold, plus an insertion arrow for join/integrate steps (a
 * pre_install/unattached/anchor step introduces its panel with
 * nothing to point INTO yet, so no arrow is drawn for those).
 */
function drawStepDiagram(doc, step, resolvedById, placedIdsSoFar, bounds, box) {
  doc.setLineWidth(0.2);
  doc.setDrawColor(210, 210, 210);
  doc.rect(box.x, box.y, box.width, box.height);

  [...placedIdsSoFar].forEach((id) => {
    const panel = resolvedById.get(id);
    if (panel) drawPanelWireframe(doc, panel, bounds, box, ALREADY_PLACED_STYLE);
  });

  const focusIds = step.panelIds.filter((id) => !placedIdsSoFar.has(id) || step.kind === 'join' || step.kind === 'integrate' || step.kind === 'pre_install');
  focusIds.forEach((id) => {
    const panel = resolvedById.get(id);
    if (panel) drawPanelWireframe(doc, panel, bounds, box, NEW_PANEL_STYLE);
  });

  if (step.kind === 'join' || step.kind === 'integrate') {
    const newlyIntroduced = step.panelIds.find((id) => !placedIdsSoFar.has(id)) ?? step.panelIds[0];
    const panel = resolvedById.get(newlyIntroduced);
    if (panel) drawInsertionArrow(doc, panel, bounds, box);
  }
}

/**
 * @param {ReturnType<typeof import('./ergonomics.js').buildAssemblyPlan>} plan
 * @param {Array} resolvedPanels - resolved (not raw) panels, same array the plan's own panel ids resolve against
 * @param {{projectName?:string, fileName?:string, mode?:'save'|'open'}} [options]
 */
export function exportAssemblyPlanPdf(plan, resolvedPanels, { projectName = 'Assembly Instructions', fileName = 'assembly-instructions.pdf', mode = 'save' } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const startX = PAGE_MARGIN_MM;

  const resolvedById = new Map(resolvedPanels.map((p) => [p.id, p]));
  const bounds = computeSharedProjectionBounds(resolvedPanels);

  // --- Cover page: parts list + tools needed, same convention as a
  // real flat-pack booklet's opening page ------------------------------
  let y = PAGE_MARGIN_MM;
  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text(projectName, startX, y);
  y += 10;

  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Tools needed', startX, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  if (plan.toolsSummary.length === 0) {
    doc.text('None.', startX, y);
    y += TEXT_LINE_HEIGHT_MM;
  } else {
    plan.toolsSummary.forEach((tool) => {
      doc.text(`- ${tool}`, startX, y);
      y += TEXT_LINE_HEIGHT_MM;
    });
  }

  y += 4;
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Parts', startX, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  resolvedPanels.filter((p) => !p.hidden).forEach((p) => {
    doc.text(`- ${p.pieceCode ?? p.id}  (${p.name ?? '?'})`, startX, y);
    y += TEXT_LINE_HEIGHT_MM;
  });

  // --- One page per step ------------------------------------------
  const placedIdsSoFar = new Set();
  plan.steps.forEach((step) => {
    doc.addPage();
    let stepY = PAGE_MARGIN_MM;

    doc.setFontSize(13);
    doc.setFont(undefined, 'bold');
    doc.text(`Step ${step.index}`, startX, stepY);
    stepY += 7;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text(step.description, startX, stepY, { maxWidth: pageWidth - PAGE_MARGIN_MM * 2 });
    stepY += 8;

    const box = { x: startX, y: stepY, width: Math.min(DIAGRAM_BOX.width, pageWidth - PAGE_MARGIN_MM * 2), height: DIAGRAM_BOX.height };
    drawStepDiagram(doc, step, resolvedById, placedIdsSoFar, bounds, box);
    stepY += box.height + 8;

    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    const ergonomicsBits = [
      `~${step.ergonomics.weightKg}kg`,
      `work surface: ${step.ergonomics.recommendedSurface}`,
    ];
    if (step.ergonomics.twoPersonJob) ergonomicsBits.push('TWO-PERSON JOB');
    if (step.ergonomics.singleJointCaution) ergonomicsBits.push('single joint — support before fastening');
    if (step.ergonomics.reorientationNeeded) ergonomicsBits.push(`flip so ${step.ergonomics.orientationAxis?.toUpperCase()} faces up`);
    doc.text(ergonomicsBits.join('   •   '), startX, stepY);
    stepY += TEXT_LINE_HEIGHT_MM;

    if (step.hardware.length > 0) {
      doc.text(`Hardware: ${step.hardware.map((h) => h.displayId).join(', ')}`, startX, stepY);
      stepY += TEXT_LINE_HEIGHT_MM;
    }
    if (step.tools.length > 0) {
      doc.text(`Tools: ${step.tools.join(', ')}`, startX, stepY, { maxWidth: pageWidth - PAGE_MARGIN_MM * 2 });
      stepY += TEXT_LINE_HEIGHT_MM;
    }

    // Update the placed-set AFTER drawing, so this step's own new
    // panel(s) still render bold rather than immediately faint.
    step.panelIds.forEach((id) => placedIdsSoFar.add(id));
  });

  if (mode === 'open') {
    window.open(doc.output('bloburl'), '_blank');
  } else {
    doc.save(fileName);
  }
}
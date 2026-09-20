/**
 * pdfExport-joints.js
 *
 * JOINT REPORT PDF — a debug/verification view over
 * engine/joints.js#detectJoints's current output for the whole
 * design: a text summary/attention block (see
 * engine/joints.js#formatSummaryLines / formatAttentionLines) followed
 * by a real TABLE, one row per joint. This is a sanity-check tool, not
 * a fabrication document the way the cut list / nesting PDFs are — its
 * job is letting you cross-check detectJoints() against what you can
 * see in the 3D view (does Left really only touch Top/Bottom/Back?
 * does the shelf really read as t_butt, not corner_butt?).
 *
 * The joinery branch's own export file, split out of the old
 * monolithic engine/pdfExport.js so this domain never needs to touch
 * what engine/pdfExport-bom.js, -history.js or -assembly.js own.
 */

import { jsPDF } from 'jspdf';
import { formatSummaryLines, formatAttentionLines, formatJointTableRow, formatFeatureJointTableRow } from './joints.js';
import { formatHardwareTableRow } from './hardware.js';
import { PAGE_MARGIN_MM, HEADER_BLOCK_HEIGHT_MM, TEXT_LINE_HEIGHT_MM, drawTableRow, outputPdf } from './pdfExport-shared.js';

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

  outputPdf(doc, mode, fileName);
}

/**
 * pdfExport-history.js
 *
 * A generic "one line of text at a time" PDF, used by the activity
 * history export below — see history/history.js#HistoryManager's own
 * activityLog (a COMPLETE, never-trimmed record of every user action
 * this session, distinct from the undo/redo stacks). Simple enough
 * not to need a column layout: one line of text, top to bottom,
 * paginated the same way engine/pdfExport-bom.js#exportCutListPdf's
 * rows are.
 *
 * Split out of the old monolithic engine/pdfExport.js so this domain
 * never needs to touch what -bom.js, -joints.js or -assembly.js own.
 */

import { jsPDF } from 'jspdf';
import { PAGE_MARGIN_MM, TEXT_LINE_HEIGHT_MM, outputPdf } from './pdfExport-shared.js';

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

  outputPdf(doc, mode, fileName);
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

/**
 * pdfExport-shared.js
 *
 * The pieces genuinely shared by two or more of the split pdfExport
 * files, pulled out of the old monolithic engine/pdfExport.js so no
 * single domain branch (bom / joints / history / assembly) needs to
 * touch a file another one owns.
 *
 * Deliberately NOT a dumping ground: helpers used by only one of the
 * split files (formatDim, drawRow, the nesting sheet-drawing helpers)
 * stayed local to that file instead of being moved here — see each
 * file's own header for what it keeps to itself and why.
 */

export const PAGE_MARGIN_MM = 15;
export const HEADER_BLOCK_HEIGHT_MM = 18;
export const TEXT_LINE_HEIGHT_MM = 6;

/**
 * Draws one row of cells across a set of columns, respecting each
 * column's own width and alignment. Shared by engine/pdfExport-bom.js
 * (via its own drawRow(), which just supplies the cut-list's fixed
 * COLUMNS) and engine/pdfExport-joints.js (which passes its own
 * JOINTS_TABLE_COLUMNS / FEATURE_JOINTS_TABLE_COLUMNS /
 * HARDWARE_TABLE_COLUMNS directly).
 *
 * @param {import('jspdf').jsPDF} doc
 * @param {number} startX
 * @param {number} y
 * @param {{widthMm:number, align?:'left'|'right'}[]} columns
 * @param {(string|number)[]} cells - one value per column, same order
 */
export function drawTableRow(doc, startX, y, columns, cells) {
  let x = startX;
  columns.forEach((col, i) => {
    const align = col.align === 'right' ? 'right' : 'left';
    doc.text(String(cells[i] ?? ''), align === 'right' ? x + col.widthMm - 1 : x + 1, y, { align });
    x += col.widthMm;
  });
}

/**
 * The "open in a new tab vs. trigger a download" branch every export
 * function in this split ends on. Kept as one place rather than five
 * near-identical if/else blocks.
 *
 * `mode: 'save'` (default) triggers a normal file download.
 * `mode: 'open'` opens the generated PDF in a new browser tab instead
 * — used by toolbar buttons like "Open Cut List", so the person can
 * look at it right away without a download prompt. jsPDF's 'bloburl'
 * output is synchronous, so this must be called inside the same
 * click-handler call stack that triggered it — important because
 * window.open() called asynchronously (e.g. after an await) gets
 * silently blocked as a popup by most browsers.
 *
 * @param {import('jspdf').jsPDF} doc
 * @param {'save'|'open'} mode
 * @param {string} fileName
 */
export function outputPdf(doc, mode, fileName) {
  if (mode === 'open') {
    window.open(doc.output('bloburl'), '_blank');
  } else {
    doc.save(fileName);
  }
}

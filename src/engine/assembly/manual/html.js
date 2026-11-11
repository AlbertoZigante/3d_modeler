import { phase4EscapeHtml } from './format.js';
import { phase4RenderStep } from './renderSteps.js';
import { phase4RenderChecklist, phase4RenderCover, phase4RenderHardwarePage, phase4RenderPartsPage } from './renderPages.js';
import { MANUAL_CSS } from './styles.js';

/**
 * Packs page fragments two per landscape sheet (left half, right half).
 * An odd last page leaves its right half blank.
 */
function phase4PackSheets(pages) {
  const list = pages.filter(Boolean);
  const sheets = [];
  for (let i = 0; i < list.length; i += 2) {
    const left = list[i];
    const right = list[i + 1];
    sheets.push(`
<div class="p4-sheet">
  <div class="p4-half">${left}</div>
  <div class="p4-half">${right || ''}</div>
</div>`);
  }
  return sheets.join('\n');
}

/**
 * Render a complete printable HTML manual.
 *
 * The returned string has no external dependencies. It can be inserted into
 * an iframe, opened in a browser, or passed to an existing HTML→PDF engine.
 */
export function renderAssemblyManualHtml(
  model
) {
  // Front matter two per sheet, then steps (and the closing checklist)
  // two per sheet: one on the left half, one on the right half.
  const frontHtml = phase4PackSheets([
    phase4RenderCover(model),
    phase4RenderPartsPage(model),
    phase4RenderHardwarePage(model),
  ]);
  const stepsHtml = phase4PackSheets([
    ...model.steps.map(phase4RenderStep),
    phase4RenderChecklist(model),
  ]);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${phase4EscapeHtml(model.title)}</title>
<style>
${MANUAL_CSS}
</style>
</head>
<body>

${frontHtml}
${stepsHtml}

</body>
</html>`;
}

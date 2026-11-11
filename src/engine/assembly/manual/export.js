import { translateHtml } from '../../../i18n/index.js';
import { buildAssemblyManualModel } from './model.js';
import { renderAssemblyManualHtml } from './html.js';

/**
 * Convenience function for hosts that already have the Phase-3 sequence.
 */
export function buildAssemblyManualHtml(
  sequence,
  options = {}
) {
  const model =
    buildAssemblyManualModel(
      sequence,
      options
    );

  return renderAssemblyManualHtml(
    model
  );
}

/**
 * Phase 4 printable/exportable assembly manual.
 *
 * Builds the Phase 4 HTML manual and opens it in a
 * print window so the browser can print/save it as PDF.
 */
export function exportAssemblyManualPdf(
  sequence,
  {
    projectName = 'Assembly Instructions',
    mode = 'open',
    panels = [],
    resolvedPanels = [],
  } = {}
) {
  const rawHtml =
    buildAssemblyManualHtml(
      sequence,
      {
        title: projectName,

        subtitle:
          'Human-first assembly instructions',

        panels:
          panels || [],

        resolvedPanels:
          resolvedPanels || [],
      }
    );

  // The manual follows the site language (no-op in English).
  const html = translateHtml(rawHtml);

  /*
   * Existing browser/PDF opening behaviour.
   */
  if (mode === 'open') {
    const printWindow =
      window.open(
        '',
        '_blank'
      );

    if (!printWindow) {
      return false;
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();

    return true;
  }

  /*
   * Keep compatibility with callers that only need
   * the generated HTML.
   */
  return html;
}

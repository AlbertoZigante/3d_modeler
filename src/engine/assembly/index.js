/**
 * engine/assembly/ — public API of the assembly planner.
 *
 *   sequence.js        buildAssemblySequence / formatAssemblySequenceLines
 *   manual/            PDF/HTML manual layer (consumes the sequence)
 *
 * Callers should import from engine/assembly.js (a re-export of this file).
 */
export { buildAssemblySequence, formatAssemblySequenceLines } from './sequence.js';
export {
  buildAssemblyManualModel,
} from './manual/model.js';
export { renderAssemblyManualHtml } from './manual/html.js';
export { buildAssemblyManualHtml, exportAssemblyManualPdf } from './manual/export.js';

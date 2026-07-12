/**
 * Selection state store.
 *
 * Kept in its own module, separate from the graph (modules.js)
 * and the view (scene.js), so later stages — multi-select, hover
 * highlighting, locking a selection during drag — extend this
 * one file instead of scattering selection logic across the
 * scene and UI panels.
 *
 * Stage 0/1: single selection, no persistence, no pub/sub — the
 * app's main.js is the sole place selection changes are reacted
 * to, keeping the data flow explicit and easy to trace.
 */

let selectedId = null;

export function getSelectedId() {
  return selectedId;
}

export function setSelectedId(id) {
  selectedId = id;
}

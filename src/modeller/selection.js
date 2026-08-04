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
let selectedGroupId = null;

export function getSelectedId() {
  return selectedId;
}

export function setSelectedId(id) {
  selectedId = id;
}

// Set only when a GROUP is selected at the "whole group" level (no
// specific member drilled into) — see modeller-main.js's
// handleCanvasSelectClick for the two-level progressive-drill-in
// logic this supports. When a specific panel IS drilled into,
// selectedId holds that panel's id and this still holds the group id
// it belongs to (so re-clicking a sibling member switches selectedId
// without needing to re-select the group first) — null only means
// "not currently inside any group's context at all".
export function getSelectedGroupId() {
  return selectedGroupId;
}

export function setSelectedGroupId(id) {
  selectedGroupId = id;
}

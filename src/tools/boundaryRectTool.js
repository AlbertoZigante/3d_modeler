/**
 * tools/boundaryRectTool.js
 *
 * BOUNDARY RECT TOOL — pick FOUR boundary panels (2 Left/Right-type,
 * 2 Top/Bottom-type — box walls or existing shelves, same rules
 * shelfTool.js already uses per axis) and hand the resulting
 * rectangle (see shared/geometry.js#computeBoundaryRectangle) to
 * whichever feature started the pick. This file owns only the
 * interaction (which panels have been picked so far, validation,
 * highlighting) — it never touches the graph and never decides what
 * to build from the result. features/door.js, features/drawer.js (and
 * any shelf-front feature) are the intended callers, via
 * startBoundaryRectMode(onComplete): each passes its own onComplete
 * to turn the resolved rectangle into an actual node.
 *
 * REQUIRED CONTRACT: computeBoundaryRectangle(panels, [n1, n2, n3, n4])
 *   -> { ok: true, groupId, sides, inner, outer }
 *    | { ok: false, reason }
 * (pickedPanels can be in any order — the function sorts out which
 * is which by rotation and position).
 *
 * Needs the same runtime handles shelfTool.js does, plus
 * setPanelHighlightSet — see setBoundaryRectToolContext() below,
 * wired once from modeller-main.js.
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';
import { BOUNDARY_ROTATION_BY_AXIS, rotationsMatch, computeBoundaryRectangle } from '../shared/geometry.js';

const REQUIRED_PICKS = 4;
const MAX_PER_AXIS = 2;
const MAX_DISTINCT_AXES = 2; // the 4 panels must bound exactly 2 of the 3 possible axes — see computeBoundaryRectangle's own doc for what the 3 combinations mean (front door / replaces Left-Right / replaces Top-Bottom)

const AXIS_LABEL = { x: 'Left/Right', y: 'Top/Bottom', z: 'Back/Front' };

const FAILURE_MESSAGES = {
  'wrong-count': "Didn't get 4 panels — try again",
  'mixed-box': 'All 4 panels must belong to the same box',
  'not-boundary': 'Need 2 panels of one boundary type and 2 of another (e.g. Left/Right + Top/Bottom)',
  'not-resolved': "Couldn't resolve one of those panels — try again",
  degenerate: 'Those panels leave no clear rectangle — try different ones',
};

/**
 * @typedef {Object} BoundaryRectToolContext
 * @property {() => Array} getPanels
 * @property {() => void} renderAll
 * @property {() => void} clearMultiSelected
 * @property {(nodeId: string|null, faceName: string|null) => void} setFaceHighlight
 * @property {(active: boolean, onPick: Function|null) => void} setFacePickMode
 * @property {(nodeIds: string[]) => void} setPanelHighlightSet
 */

/** @type {BoundaryRectToolContext|null} */
let ctx = null;

let active = false;
let picked = []; // raw panel nodes, in pick order — up to REQUIRED_PICKS
let onComplete = null; // (result) => void, supplied by the caller feature

/**
 * Wires this tool to the live app. Call once from modeller-main.js
 * after createModellerScene() exists.
 * @param {BoundaryRectToolContext} context
 */
export function setBoundaryRectToolContext(context) {
  ctx = context;
}

/** For modeller-main.js's toolbar rendering (button active-state). */
export function isBoundaryRectActive() {
  return active;
}

/** How many of the 4 panels have been picked so far — for status UI. */
export function getBoundaryRectProgress() {
  return picked.length;
}

/**
 * @param {(result: ReturnType<typeof computeBoundaryRectangle>) => void} onCompleteCallback
 *   Called once with the computeBoundaryRectangle() result after the
 *   4th valid pick — success or failure. The tool always exits pick
 *   mode after this (retrying on failure means starting again).
 */
export function startBoundaryRectMode(onCompleteCallback) {
  active = true;
  picked = [];
  onComplete = onCompleteCallback || null;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setPanelHighlightSet([]);
  ctx.setFacePickMode(true, handleRectPick);
  showToast(`Front rectangle: pick a boundary panel (Left/Right, Top/Bottom, Back/Front, or an existing shelf) — 0/${REQUIRED_PICKS}`, false);
  ctx.renderAll();
}

export function cancelBoundaryRectMode() {
  active = false;
  picked = [];
  onComplete = null;
  setSelectedId(null);
  ctx.setFaceHighlight(null, null);
  ctx.setPanelHighlightSet([]);
  ctx.setFacePickMode(false, null);
  hideToast();
  ctx.renderAll();
}

function axisOf(node) {
  return Object.keys(BOUNDARY_ROTATION_BY_AXIS).find((axis) => rotationsMatch(node.rotation, BOUNDARY_ROTATION_BY_AXIS[axis])) || null;
}

function countOnAxis(axis) {
  return picked.filter((p) => axisOf(p) === axis).length;
}

function distinctAxesPicked() {
  return new Set(picked.map(axisOf));
}

function handleRectPick(nodeId) {
  const panels = ctx.getPanels();
  const node = panels.find((p) => p.id === nodeId);
  if (!node) return;

  const axis = axisOf(node);
  if (!node.groupId || !axis) {
    showToast('Pick a Left/Right, Top/Bottom, or Back/Front panel — or an existing shelf');
    return;
  }
  if (picked.some((p) => p.id === nodeId)) {
    showToast('Already picked that panel — pick a different one');
    return;
  }
  if (picked.length > 0 && picked[0].groupId !== node.groupId) {
    showToast('All 4 panels must belong to the same box');
    return;
  }
  if (countOnAxis(axis) >= MAX_PER_AXIS) {
    showToast(`Already have 2 ${AXIS_LABEL[axis]} panels — pick a different boundary type`);
    return;
  }
  const usedAxes = distinctAxesPicked();
  if (!usedAxes.has(axis) && usedAxes.size >= MAX_DISTINCT_AXES) {
    const usedLabels = [...usedAxes].map((a) => AXIS_LABEL[a]).join(' + ');
    showToast(`The 4 panels must bound only 2 boundary types — already picking ${usedLabels}`);
    return;
  }

  picked.push(node);
  ctx.setPanelHighlightSet(picked.map((p) => p.id));

  if (picked.length < REQUIRED_PICKS) {
    showToast(`Front rectangle: pick another boundary panel — ${picked.length}/${REQUIRED_PICKS}`, false);
    ctx.renderAll();
    return;
  }

  const result = computeBoundaryRectangle(panels, picked);
  if (!result.ok) {
    showToast(FAILURE_MESSAGES[result.reason] || "Couldn't compute a rectangle from those panels");
  }

  const callback = onComplete;
  cancelBoundaryRectMode();
  callback?.(result);
}

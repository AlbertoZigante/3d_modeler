/**
 * tools/shelfTool.js
 *
 * SHELF TOOL — box-only pick-mode interaction. Pick two BOUNDARY
 * panels on the same axis; features/shelf.js#addShelf() does the
 * actual creation math. This file owns only interaction state (which
 * mode is active, what's been picked so far) and wires picks to the
 * scene — it never touches the graph directly.
 *
 * REQUIRED CONTRACT for features/shelf.js#addShelf, now that it's
 * pure (previously read shelfMode/shelfPick1ClickMm as closures over
 * modeller-main.js, which no longer exist once extracted):
 *
 *   addShelf(panels, pick1, pick2, { mode, clickMm })
 *     -> { ok: true, node, groupId }
 *      | { ok: false, reason: 'no-space-at-click' | 'no-space' }
 *
 * Needs a few runtime handles that aren't module-level exports
 * anywhere (the live panels array, history/render, the scene's
 * pick-mode hooks) — see setShelfToolContext() below, called once
 * from modeller-main.js after the scene is created.
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';
import { VERTICAL_ROTATION, HORIZONTAL_ROTATION, rotationsMatch } from '../shared/geometry.js';
import { MM_TO_UNIT } from '../modeller/modules.js';
import { addShelf } from '../features/shelf.js';
import { AddShelfCommand } from '../history/history.js';

// A panel's ROTATION, not its name, is what makes it a valid boundary
// — lets an existing shelf stand in for Left/Right/Top/Bottom. See
// features/box.js for why Left/Right = VERTICAL_ROTATION, Top/Bottom
// = HORIZONTAL_ROTATION.
const SHELF_BOUNDARY_ROTATION = { horizontal: () => VERTICAL_ROTATION, vertical: () => HORIZONTAL_ROTATION };

const FAILURE_MESSAGES = {
  'no-space-at-click': 'Not enough space for a shelf there',
  'no-space': 'Not enough space for another shelf here',
};

/**
 * @typedef {Object} ShelfToolContext
 * @property {() => Array} getPanels
 * @property {(nodes: Array, CommandClass: Function) => void} commitAddedNodes
 *   Appends `nodes` to the graph, records ONE history command covering
 *   the addition (before = panels pre-append, after = panels post-append).
 * @property {() => void} renderAll
 * @property {() => void} clearMultiSelected
 * @property {(nodeId: string|null, faceName: string|null) => void} setFaceHighlight
 * @property {(active: boolean, onPick: Function|null) => void} setFacePickMode
 * @property {(nodeId: string, faceName: string) => void} setPanelHighlight
 */

/** @type {ShelfToolContext|null} */
let ctx = null;

let shelfMode = null;
let shelfPick1 = null;
let shelfPick1ClickMm = null; // desired position along the shelf's free axis, from where the first pick was clicked — null if unavailable (e.g. 2D view), in which case addShelf falls back to auto-placement

/**
 * Wires this tool to the live app. Call once from modeller-main.js
 * after createModellerScene() exists.
 * @param {ShelfToolContext} context
 */
export function setShelfToolContext(context) {
  ctx = context;
}

/** For modeller-main.js's toolbar rendering (button active-state). */
export function getShelfMode() {
  return shelfMode;
}

export function startShelfMode(mode) {
  shelfMode = mode;
  shelfPick1 = null;
  shelfPick1ClickMm = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(true, handleShelfPick);
  const kind = mode === 'horizontal' ? 'Left/Right (or an existing vertical shelf)' : 'Top/Bottom (or an existing horizontal shelf)';
  showToast(`${mode === 'horizontal' ? 'Horizontal' : 'Vertical'} shelf: pick a box's ${kind}`, false);
  ctx.renderAll();
}

export function cancelShelfMode() {
  shelfMode = null;
  shelfPick1 = null;
  shelfPick1ClickMm = null;
  setSelectedId(null);
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(false, null);
  hideToast();
  ctx.renderAll();
}

// Converts a raycast hit point (world units) into an offset-space mm
// value along one axis, relative to the box's shared basePosition —
// same space every shelf/wall offset already lives in.
function computeClickOffsetMm(node, worldPoint, axis) {
  const worldMm = { x: worldPoint.x / MM_TO_UNIT, y: worldPoint.y / MM_TO_UNIT, z: worldPoint.z / MM_TO_UNIT };
  return worldMm[axis] - node.basePosition[axis];
}

function handleShelfPick(nodeId, faceName, worldPoint) {
  const panels = ctx.getPanels();
  const node = panels.find((p) => p.id === nodeId);
  if (!node) return;

  const wantRotation = SHELF_BOUNDARY_ROTATION[shelfMode]();
  const kindLabel = shelfMode === 'horizontal' ? 'a Left/Right panel or an existing vertical shelf' : 'a Top/Bottom panel or an existing horizontal shelf';
  if (!node.groupId || !rotationsMatch(node.rotation, wantRotation)) {
    showToast(`Pick ${kindLabel}`);
    return;
  }

  if (!shelfPick1) {
    shelfPick1 = node;
    const freeAxis = shelfMode === 'horizontal' ? 'y' : 'x';
    shelfPick1ClickMm = worldPoint ? computeClickOffsetMm(node, worldPoint, freeAxis) : null;
    ctx.setPanelHighlight(nodeId, faceName);
    showToast(`Now pick the OTHER boundary of the SAME box (${kindLabel})`, false);
    ctx.renderAll();
    return;
  }

  if (shelfPick1.id === nodeId) {
    showToast('Pick a DIFFERENT panel, not the same one again');
    return;
  }
  if (shelfPick1.groupId !== node.groupId) {
    showToast('Both panels must belong to the same box');
    return;
  }

  const result = addShelf(panels, shelfPick1, node, { mode: shelfMode, clickMm: shelfPick1ClickMm });
  if (!result.ok) {
    showToast(FAILURE_MESSAGES[result.reason] || "Can't place a shelf there");
    return; // stay in pick mode — let them retry the second pick
  }

  ctx.commitAddedNodes([result.node], AddShelfCommand);
  setSelectedGroupId(result.groupId);
  setSelectedId(result.node.id);
  cancelShelfMode();
}

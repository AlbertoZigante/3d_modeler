/**
 * tools/leg.js
 *
 * ADD LEGS — pick-a-box tool. Clicking the toolbar's Leg button
 * deselects everything (3D + 2D) and enters a single-click pick mode;
 * the next click on any panel of a box immediately builds the 4 legs
 * under that box and lifts the box by the leg height (see
 * features/leg.js#addLegsAndRaiseBox). No confirm step.
 *
 * Only orchestrates interaction state — modeller-main.js remains the
 * single writer that turns the picked groupId into a history-tracked
 * graph change (ctx.onBoxPicked).
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';

/**
 * @typedef {Object} LegToolContext
 * @property {() => Array} getPanels
 * @property {() => void} renderAll
 * @property {() => void} clearMultiSelected
 * @property {(nodeId: string|null, faceName: string|null) => void} setFaceHighlight
 * @property {(active: boolean, onPick: Function|null) => void} setFacePickMode
 * @property {(nodeIds: string[]) => void} setPanelHighlightSet
 * @property {(groupId: string) => void} onBoxPicked
 */

/** @type {LegToolContext|null} */
let ctx = null;
let active = false;

export function setLegToolContext(context) {
  ctx = context;
}

export function isLegPickActive() {
  return active;
}

export function startLegMode() {
  active = true;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setPanelHighlightSet([]);
  ctx.setFacePickMode(true, handleLegPick);
  showToast('Legs: click a box to place 4 legs under its Bottom panel', false);
  ctx.renderAll();
}

function handleLegPick(nodeId) {
  const node = ctx.getPanels().find((p) => p.id === nodeId);
  if (!node || !node.groupId) {
    showToast('Pick a panel that belongs to a box');
    return;
  }
  const groupId = node.groupId;
  finish();
  ctx.onBoxPicked(groupId);
}

function finish() {
  active = false;
  setSelectedId(null);
  ctx.setFaceHighlight(null, null);
  ctx.setPanelHighlightSet([]);
  ctx.setFacePickMode(false, null);
  hideToast();
}

export function cancelLegMode() {
  if (!active) return;
  finish();
  ctx.renderAll();
}

/**
 * tools/plinth.js
 *
 * ADD PLINTH — pick-a-box tool. Clicking the toolbar's Plinth button
 * deselects everything (3D + 2D) and enters a single-click pick mode;
 * the next click on any panel of a box immediately builds the plinth
 * under that box and lifts the box by the plinth's height (see
 * features/plinth.js#addPlinthAndRaiseBox). No confirm step.
 *
 * Only orchestrates interaction state — modeller-main.js remains the
 * single writer that turns the picked groupId into a history-tracked
 * graph change (ctx.onBoxPicked).
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';

/**
 * @typedef {Object} PlinthToolContext
 * @property {() => Array} getPanels
 * @property {() => void} renderAll
 * @property {() => void} clearMultiSelected
 * @property {(nodeId: string|null, faceName: string|null) => void} setFaceHighlight
 * @property {(active: boolean, onPick: Function|null) => void} setFacePickMode
 * @property {(nodeIds: string[]) => void} setPanelHighlightSet
 * @property {(groupId: string) => void} onBoxPicked
 */

/** @type {PlinthToolContext|null} */
let ctx = null;
let active = false;

export function setPlinthToolContext(context) {
  ctx = context;
}

export function isPlinthPickActive() {
  return active;
}

export function startPlinthMode() {
  active = true;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setPanelHighlightSet([]);
  ctx.setFacePickMode(true, handlePlinthPick);
  showToast('Plinth: click a box to place the plinth under it', false);
  ctx.renderAll();
}

function handlePlinthPick(nodeId) {
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

export function cancelPlinthMode() {
  if (!active) return;
  finish();
  ctx.renderAll();
}

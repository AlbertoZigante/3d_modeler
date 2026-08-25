/**
 * tools/attachTool.js
 *
 * ATTACH TOOL — the manual/generic joint path, for declaring a joint
 * between two arbitrary panels outside any automated feature (box,
 * shelf, drawer, door all declare their own joints directly via
 * engine/joints.js#declareJoint at creation time — this tool is for
 * everything else). Same two-pick shape as collinearTool.js, but the
 * second pick doesn't commit immediately: it classifies a SUGGESTED
 * joint type and waits for explicit user confirmation before
 * anything is written to the graph — this is a hard rule, not a UX
 * nicety (see the joints design notes).
 *
 * DEPENDS ON engine/joints.js, which is currently unimplemented. This
 * file assumes:
 *   classifyJoint(panels, nodeAId, faceA, nodeBId, faceB)
 *     -> { type, params } | null   (null = no plausible joint here)
 *   declareJoint(nodeAId, faceA, nodeBId, faceB, type, params)
 *     -> relation object to attach to the graph
 * If your real classifyJoint/declareJoint signatures differ, only
 * the two call sites below (handleAttachPick, confirmAttach) need to
 * change — the pick-state/confirmation flow doesn't depend on the
 * exact shape.
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';
import { classifyJoint, declareJoint } from '../engine/joints.js';
import { AddConstraintCommand } from '../history/history.js';

/**
 * @typedef {Object} AttachToolContext
 * @property {() => Array} getPanels
 * @property {(id: string, patch: Object) => void} updateNode
 * @property {(CommandClass: Function, before: Array, after: Array) => void} recordHistoryCommand
 * @property {() => void} renderAll
 * @property {() => void} clearMultiSelected
 * @property {(nodeId: string|null, faceName: string|null) => void} setFaceHighlight
 * @property {(active: boolean, onPick: Function|null) => void} setFacePickMode
 */

/** @type {AttachToolContext|null} */
let ctx = null;

let attachActive = false;
let attachPick1 = null; // { nodeId, faceName } | null

// Set once a valid pair has been picked and classified — holds the
// SUGGESTED joint, not yet written to the graph. Nothing is committed
// until confirmAttach() is explicitly called.
let pendingAttach = null; // { pick1, pick2, type, params } | null

/**
 * Wires this tool to the live app. Call once from modeller-main.js
 * after createModellerScene() exists.
 * @param {AttachToolContext} context
 */
export function setAttachToolContext(context) {
  ctx = context;
}

export function isAttachActive() {
  return attachActive;
}

/** For a confirmation UI (e.g. a toolbar "Confirm joint" button) to render against. */
export function getPendingAttach() {
  return pendingAttach;
}

export function startAttachMode() {
  attachActive = true;
  attachPick1 = null;
  pendingAttach = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(true, handleAttachPick);
  showToast('Attach: pick a face on the first panel', false);
  ctx.renderAll();
}

export function cancelAttachMode() {
  attachActive = false;
  attachPick1 = null;
  pendingAttach = null;
  setSelectedId(null);
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(false, null);
  hideToast();
  ctx.renderAll();
}

/** Rejects a pending suggestion without leaving attach mode — lets the user retry the second pick. */
export function cancelPendingAttach() {
  pendingAttach = null;
  attachPick1 = null;
  ctx.setFaceHighlight(null, null);
  showToast('Attach: pick a face on the first panel', false);
  ctx.renderAll();
}

function handleAttachPick(nodeId, faceName) {
  if (pendingAttach) return; // a suggestion is already awaiting confirm/reject — ignore further picks until resolved

  if (!attachPick1) {
    attachPick1 = { nodeId, faceName };
    ctx.setFaceHighlight(nodeId, faceName);
    showToast('Now pick a face on the OTHER panel to attach', false);
    ctx.renderAll();
    return;
  }

  if (attachPick1.nodeId === nodeId) {
    showToast('Pick a face on a DIFFERENT panel');
    return;
  }

  const panels = ctx.getPanels();
  const suggestion = classifyJoint(panels, attachPick1.nodeId, attachPick1.faceName, nodeId, faceName);
  if (!suggestion) {
    showToast("Those two faces don't form a recognizable joint — try a different pair");
    attachPick1 = null;
    ctx.setFaceHighlight(null, null);
    ctx.renderAll();
    return;
  }

  pendingAttach = { pick1: attachPick1, pick2: { nodeId, faceName }, type: suggestion.type, params: suggestion.params };
  showToast(`Suggested joint: ${suggestion.type.replace('_', ' ')} — confirm to attach, or pick again to cancel`, false);
  ctx.renderAll();
}

/**
 * Explicit user confirmation — the only place a joint relation is
 * ever actually written to the graph from this tool. Mirrors the
 * same declareJoint() call site every automated feature (box, shelf,
 * drawer, door) uses internally, so a manually-confirmed joint and an
 * automated one are structurally identical relations.
 */
export function confirmAttach() {
  if (!pendingAttach) return;
  const { pick1, pick2, type, params } = pendingAttach;

  const relation = declareJoint(pick1.nodeId, pick1.faceName, pick2.nodeId, pick2.faceName, type, params);

  const panels = ctx.getPanels();
  const node1 = panels.find((p) => p.id === pick1.nodeId);
  const otherRelations = (node1.relations || []).filter((r) => r.id !== relation.id);

  const before = ctx.getPanels();
  ctx.updateNode(pick1.nodeId, { relations: [...otherRelations, relation] });
  const after = ctx.getPanels();
  ctx.recordHistoryCommand(AddConstraintCommand, before, after);

  cancelAttachMode();
}

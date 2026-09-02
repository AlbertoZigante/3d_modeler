/**
 * tools/doorTool.js
 *
 * ADD DOOR — the "Front Rect" toolbar button's real feature, now that
 * features/door.js exists to consume it. Two phases:
 *
 *   1. PICKING — delegates entirely to tools/boundaryRectTool.js's
 *      existing 4-panel pick (same highlighting, same validation —
 *      nothing door-specific about picking itself).
 *   2. CONFIRMING — once 4 valid panels are picked, holds the
 *      resulting computeBoundaryRectangle() result plus a local
 *      (uncommitted) edgeFit the person can freely edit via
 *      ui/toolbar.js's confirm form. Nothing is written to the graph
 *      until confirmDoorMode() — Cancel at this point just drops the
 *      pick and touches nothing, same as any other tool's Escape.
 *
 * Like boundaryRectTool.js, this file only orchestrates interaction
 * state — the actual placement math is features/door.js
 * (computeDoorPlacement/createDoorNode), and modeller-main.js remains
 * the single writer that turns a confirmed placement into a real
 * history-tracked graph change.
 */
import { startBoundaryRectMode, cancelBoundaryRectMode } from './boundaryRectTool.js';
import { computeDoorPlacement, DEFAULT_DOOR_EDGE_FIT, DEFAULT_DOOR_HINGE } from '../features/door.js';
import { showToast, hideToast } from '../ui/toast.js';

const FAILURE_MESSAGES = {
  'invalid-boundary-result': "Didn't get a valid rectangle — try picking again",
  'not-resolved': "Couldn't resolve one of those panels — try again",
  degenerate: 'That edge fit leaves no room for a door — try different in/out settings',
  'panel-too-short': "That edge fit would shrink a boundary panel too much — try different in/out settings",
};

/**
 * @typedef {Object} DoorToolContext
 * @property {() => Array} getPanels
 * @property {() => void} renderAll
 */

/** @type {DoorToolContext|null} */
let ctx = null;

let phase = null; // null | 'picking' | 'confirming'
let boundaryResult = null;
let edgeFit = null;
let hinge = null;

/** Wires this tool to the live app. Call once from modeller-main.js. */
export function setDoorToolContext(context) {
  ctx = context;
}

export function isDoorPickActive() {
  return phase === 'picking';
}

export function isDoorConfirmActive() {
  return phase === 'confirming';
}

/** For the confirm-phase form — null outside that phase. */
export function getDoorEdgeFit() {
  return edgeFit;
}

/** For the confirm-phase form — which vertical edge the door hinges on (see features/door.js#computeDoorOpenTransform). Null outside the confirm phase. */
export function getDoorHinge() {
  return hinge;
}

export function startDoorMode() {
  phase = 'picking';
  boundaryResult = null;
  edgeFit = { ...DEFAULT_DOOR_EDGE_FIT };
  hinge = DEFAULT_DOOR_HINGE;
  startBoundaryRectMode(handleBoundaryPicked);
}

function handleBoundaryPicked(result) {
  if (!result.ok) {
    // boundaryRectTool.js already toasted the specific reason
    phase = null;
    boundaryResult = null;
    edgeFit = null;
    hinge = null;
    ctx.renderAll();
    return;
  }
  boundaryResult = result;
  phase = 'confirming';
  ctx.renderAll();
}

/** Called by the confirm form's 4 selects — doesn't touch the graph, just this tool's own pending state. */
export function setDoorEdgeFitField(edge, value) {
  if (!edgeFit) return;
  edgeFit = { ...edgeFit, [edge]: value };
  ctx.renderAll();
}

/** Called by the confirm form's hinge select — same pending-state-only rule as setDoorEdgeFitField. */
export function setDoorHinge(value) {
  if (!hinge) return;
  hinge = value === 'right' ? 'right' : 'left';
  ctx.renderAll();
}

export function cancelDoorMode() {
  if (phase === 'picking') cancelBoundaryRectMode(); // clears its own highlight/pick-mode/toast
  phase = null;
  boundaryResult = null;
  edgeFit = null;
  hinge = null;
  hideToast();
  ctx.renderAll();
}

/**
 * @param {{material: string, thicknessMm: number}} doorSpec
 * @param {(placement: ReturnType<typeof computeDoorPlacement>) => void} onConfirm
 *   Called ONLY on success, with a ready-to-apply placement — the
 *   caller (modeller-main.js) creates the actual node, patches the 4
 *   boundary panels, and commits it all as one history entry.
 */
export function confirmDoorMode(doorSpec, onConfirm) {
  if (phase !== 'confirming' || !boundaryResult) return;

  const placement = computeDoorPlacement(ctx.getPanels(), boundaryResult, edgeFit, { ...doorSpec, hinge });
  if (!placement.ok) {
    showToast(FAILURE_MESSAGES[placement.reason] || "Couldn't place the door");
    return;
  }

  phase = null;
  boundaryResult = null;
  edgeFit = null;
  hinge = null;
  hideToast();
  onConfirm(placement);
}

/**
 * tools/drawerTool.js
 *
 * ADD DRAWER — the "Add Drawer" toolbar button's real feature, now
 * that features/drawer.js exists to consume it. Two phases, identical
 * shape to tools/doorTool.js (see that file's own header comment for
 * the full rationale — repeated only where it differs here):
 *
 *   1. PICKING — delegates entirely to tools/boundaryRectTool.js's
 *      existing 4-panel pick, exactly like doorTool.js does.
 *   2. CONFIRMING — once 4 valid panels are picked, holds the
 *      resulting computeBoundaryRectangle() result plus a local
 *      (uncommitted) edgeFit AND drawer count the person can freely
 *      edit via ui/toolbar.js's confirm form. Nothing is written to
 *      the graph until confirmDrawerMode().
 *
 * The one real difference from doorTool.js: a count field instead of
 * a hinge — drawer fronts don't hinge/open in this codebase's model
 * (see features/drawer.js's own header comment on what's NOT built
 * yet), they just fill the opening as N stacked panels.
 */
import { startBoundaryRectMode, cancelBoundaryRectMode } from './boundaryRectTool.js';
import { computeDrawerFrontsPlacement, DEFAULT_DRAWER_EDGE_FIT, DEFAULT_DRAWER_COUNT, MAX_DRAWER_COUNT } from '../features/drawer.js';
import { showToast, hideToast } from '../ui/toast.js';

const FAILURE_MESSAGES = {
  'invalid-boundary-result': "Didn't get a valid rectangle — try picking again",
  'not-resolved': "Couldn't resolve one of those panels — try again",
  degenerate: 'That edge fit leaves no room for a drawer front — try different in/out settings',
  'panel-too-short': "That count/edge fit would make a drawer front too short — try fewer drawers or different in/out settings",
  'invalid-count': `Number of drawers must be between 1 and ${MAX_DRAWER_COUNT}`,
};

/**
 * @typedef {Object} DrawerToolContext
 * @property {() => Array} getPanels
 * @property {() => void} renderAll
 */

/** @type {DrawerToolContext|null} */
let ctx = null;

let phase = null; // null | 'picking' | 'confirming'
let boundaryResult = null;
let edgeFit = null;
let count = null;

/** Wires this tool to the live app. Call once from modeller-main.js. */
export function setDrawerToolContext(context) {
  ctx = context;
}

export function isDrawerPickActive() {
  return phase === 'picking';
}

export function isDrawerConfirmActive() {
  return phase === 'confirming';
}

/** For the confirm-phase form — null outside that phase. */
export function getDrawerEdgeFit() {
  return edgeFit;
}

/** For the confirm-phase form — how many equal fronts to subdivide the opening into. Null outside the confirm phase. */
export function getDrawerCount() {
  return count;
}

export function startDrawerMode() {
  phase = 'picking';
  boundaryResult = null;
  edgeFit = { ...DEFAULT_DRAWER_EDGE_FIT };
  count = DEFAULT_DRAWER_COUNT;
  startBoundaryRectMode(handleBoundaryPicked);
}

function handleBoundaryPicked(result) {
  if (!result.ok) {
    // boundaryRectTool.js already toasted the specific reason
    phase = null;
    boundaryResult = null;
    edgeFit = null;
    count = null;
    ctx.renderAll();
    return;
  }
  boundaryResult = result;
  phase = 'confirming';
  ctx.renderAll();
}

/** Called by the confirm form's 4 selects — doesn't touch the graph, just this tool's own pending state. */
export function setDrawerEdgeFitField(edge, value) {
  if (!edgeFit) return;
  edgeFit = { ...edgeFit, [edge]: value };
  ctx.renderAll();
}

/** Called by the confirm form's count input — same pending-state-only rule as setDrawerEdgeFitField. Clamped here so a stray keystroke can't leave `count` as NaN/out-of-range mid-typing. */
export function setDrawerCount(value) {
  if (count === null) return;
  const parsed = Math.round(Number(value));
  count = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_DRAWER_COUNT) : DEFAULT_DRAWER_COUNT;
  ctx.renderAll();
}

export function cancelDrawerMode() {
  if (phase === 'picking') cancelBoundaryRectMode(); // clears its own highlight/pick-mode/toast
  phase = null;
  boundaryResult = null;
  edgeFit = null;
  count = null;
  hideToast();
  ctx.renderAll();
}

/**
 * @param {{material: string, thicknessMm: number}} drawerSpec
 * @param {(placement: ReturnType<typeof computeDrawerFrontsPlacement>) => void} onConfirm
 *   Called ONLY on success, with a ready-to-apply placement — the
 *   caller (modeller-main.js) creates the actual nodes, patches the 4
 *   boundary panels, and commits it all as one history entry.
 */
export function confirmDrawerMode(drawerSpec, onConfirm) {
  if (phase !== 'confirming' || !boundaryResult) return;

  const placement = computeDrawerFrontsPlacement(ctx.getPanels(), boundaryResult, edgeFit, { ...drawerSpec, count });
  if (!placement.ok) {
    showToast(FAILURE_MESSAGES[placement.reason] || "Couldn't place the drawer fronts");
    return;
  }

  phase = null;
  boundaryResult = null;
  edgeFit = null;
  count = null;
  hideToast();
  onConfirm(placement);
}

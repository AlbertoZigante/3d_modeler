/**
 * tools/drawerTool.js
 *
 * ADD DRAWER — the "Add Drawer" toolbar button's real feature, now
 * that features/drawer.js exists to consume it. Identical shape to
 * tools/doorTool.js (see that file's own header comment for the full
 * rationale — repeated only where it differs here):
 *
 * Single phase: PICKING — delegates entirely to
 * tools/boundaryRectTool.js's existing 4-panel pick, exactly like
 * doorTool.js does. The moment a valid 4-panel boundary is picked,
 * DEFAULT_DRAWER_COUNT fronts are placed immediately with
 * DEFAULT_DRAWER_EDGE_FIT — no confirm step, no form. Fine-tuning
 * edge fit afterward means selecting one of the new fronts, which
 * shows the same interactive schema live (see
 * ui/properties.js's drawerSectionHTML). Count itself has no
 * post-creation control (see that file), so DEFAULT_DRAWER_COUNT is
 * effectively every drawer's count now, not just its starting point.
 *
 * The one real difference from doorTool.js: no hinge — drawer fronts
 * don't hinge/open in this codebase's model (see features/drawer.js's
 * own header comment on what's NOT built yet), they just fill the
 * opening as N stacked panels.
 */
import { startBoundaryRectMode, cancelBoundaryRectMode } from './boundaryRectTool.js';

/**
 * @typedef {Object} DrawerToolContext
 * @property {() => void} renderAll
 * @property {(boundaryResult: object) => void} onBoundaryPicked
 *   Called with a successful (ok:true) computeBoundaryRectangle
 *   result — builds+commits the drawer fronts immediately with
 *   default edge fit/count. Failure toasts are handled by
 *   boundaryRectTool.js itself (an invalid pick never reaches here).
 */

/** @type {DrawerToolContext|null} */
let ctx = null;

let active = false;

/** Wires this tool to the live app. Call once from modeller-main.js. */
export function setDrawerToolContext(context) {
  ctx = context;
}

export function isDrawerPickActive() {
  return active;
}

export function startDrawerMode() {
  active = true;
  startBoundaryRectMode(handleBoundaryPicked);
}

function handleBoundaryPicked(result) {
  active = false;
  if (result.ok) {
    ctx.onBoundaryPicked(result);
  } else {
    // boundaryRectTool.js already toasted the specific reason
    ctx.renderAll();
  }
}

export function cancelDrawerMode() {
  if (active) cancelBoundaryRectMode(); // clears its own highlight/pick-mode/toast
  active = false;
  ctx.renderAll();
}

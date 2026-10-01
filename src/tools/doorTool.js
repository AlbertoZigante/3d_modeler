/**
 * tools/doorTool.js
 *
 * ADD DOOR — the "Front Rect" toolbar button's real feature, now that
 * features/door.js exists to consume it.
 *
 * Single phase now: PICKING — delegates entirely to
 * tools/boundaryRectTool.js's existing 4-panel pick (same
 * highlighting, same validation — nothing door-specific about picking
 * itself). The moment a valid 4-panel boundary is picked, the door is
 * placed immediately (DEFAULT_DOOR_EDGE_FIT/DEFAULT_DOOR_HINGE — no
 * confirm step, no form) — the person fine-tunes edge fit/hinge
 * afterward by selecting the new door, which shows the exact same
 * interactive schema live (see ui/properties.js's doorSectionHTML)
 * rather than a separate uncommitted-state confirm form. This used to
 * be a 2-phase tool (picking, then confirming); ctx.onBoundaryPicked
 * is what modeller-main.js now supplies to build+commit the door
 * node right from here instead of waiting for a Confirm click.
 *
 * Like boundaryRectTool.js, this file only orchestrates interaction
 * state — the actual placement math is features/door.js
 * (computeDoorPlacement/createDoorNode), and modeller-main.js remains
 * the single writer that turns a picked boundary into a real
 * history-tracked graph change.
 */
import { startBoundaryRectMode, cancelBoundaryRectMode } from './boundaryRectTool.js';

/**
 * @typedef {Object} DoorToolContext
 * @property {() => void} renderAll
 * @property {(boundaryResult: object) => void} onBoundaryPicked
 *   Called with a successful (ok:true) computeBoundaryRectangle
 *   result — builds+commits the door immediately with default
 *   edge fit/hinge. Failure toasts are handled by boundaryRectTool.js
 *   itself (an invalid pick never reaches here).
 */

/** @type {DoorToolContext|null} */
let ctx = null;

let active = false;

/** Wires this tool to the live app. Call once from modeller-main.js. */
export function setDoorToolContext(context) {
  ctx = context;
}

export function isDoorPickActive() {
  return active;
}

export function startDoorMode() {
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

export function cancelDoorMode() {
  if (active) cancelBoundaryRectMode(); // clears its own highlight/pick-mode/toast
  active = false;
  ctx.renderAll();
}

/**
 * shared/handle.js
 *
 * A door/drawer handle is bought hardware (LMC Store/Häfele per this
 * project's own supplier list), never cut from panel material — so
 * it's deliberately NOT a graph node/panel here (that would make it
 * show up in the cut list/BOM as if it needed cutting, and Häfele
 * hardware isn't priced or nested the way a panel is). Instead it's
 * computed fresh from a door/drawer-front's own resolved geometry and
 * attached as a plain child THREE.Mesh in modeller/scene.js — nothing
 * here touches panels/history/render, same PURE-module rule as every
 * features/*.js file.
 *
 * Positions are returned in the panel mesh's own LOCAL space, meant to
 * be used directly as a CHILD mesh's local position/rotation — per
 * modeller/scene.js's own convention, a panel's BoxGeometry is always
 * built as (width, height, thickness) in that fixed LOCAL X/Y/Z order,
 * with the node's `rotation` then applied to the MESH (not baked into
 * the geometry) to orient it into world space. That means LOCAL X
 * always corresponds to the node's own `width` field, LOCAL Y to
 * `height`, LOCAL Z to `thickness`, regardless of which world axis
 * each actually maps to for a given rotation — so nothing here needs
 * normalAxis/axisA/axisB at all, only width/height/thickness/hinge/
 * sign, and a child mesh gets the parent's rotation for free.
 */

export const HANDLE_LENGTH_MM = 128; // a common bar-handle length/hole-spacing
export const HANDLE_CROSS_SECTION_MM = 14; // the handle's own thickness, both non-length dimensions
export const HANDLE_PROTRUSION_MM = 25; // how far it stands off the face
export const DOOR_HANDLE_EDGE_MARGIN_MM = 32; // distance from the door's free (non-hinge) edge to the handle's OWN near edge

/**
 * @param {Object} node - a resolved door or drawer-front node. Needs
 *   isDoor/isDrawerFront, width/height/thickness, and — for a door —
 *   hinge and doorSign; for a drawer front, sign. (All of these are
 *   custom fields resolveConstraints strips — see
 *   modeller-main.js#renderAll's own doorFieldsById/
 *   drawerFrontFieldsById comments — so the caller must have already
 *   re-attached them before calling this.)
 * @returns {{ localOffset:{x:number,y:number,z:number},
 *   dims:{length:number, crossSection:number, protrusion:number},
 *   axis:'x'|'y' } | null} axis is which LOCAL axis the handle's
 *   LENGTH runs along ('x' = horizontal/along width, 'y' = vertical/
 *   along height) — null for anything that isn't a door or drawer
 *   front (no handle to draw).
 */
export function computeHandlePlacement(node) {
  if (!node?.isDoor && !node?.isDrawerFront) return null;

  const dims = { length: HANDLE_LENGTH_MM, crossSection: HANDLE_CROSS_SECTION_MM, protrusion: HANDLE_PROTRUSION_MM };
  // Which LOCAL Z direction is the panel's OUTER (visible, away from
  // the cabinet interior) face — the handle has to stick out from
  // THAT side, not the hidden inner one. doorSign/sign both already
  // encode "which way the outer face points" (see
  // shared/frontFit.js#computeFrontFit's own `sign`) — ASSUMPTION,
  // not yet visually verified: that LOCAL +Z tracks the same
  // direction as the world axis that sign was computed against. If
  // the handle renders sunk into the panel instead of standing proud
  // of it, flip this one multiplier.
  const outerSign = node.isDoor ? (node.doorSign ?? 1) : (node.sign ?? 1);
  const zOffset = outerSign * (node.thickness / 2 + dims.protrusion / 2);

  if (node.isDrawerFront) {
    // Horizontal: length runs along LOCAL X (= the node's own `width`
    // field), centered on both width and height.
    return { localOffset: { x: 0, y: 0, z: zOffset }, dims, axis: 'x' };
  }

  // Door: vertical (length along LOCAL Y = `height`), offset
  // DOOR_HANDLE_EDGE_MARGIN_MM in from the edge OPPOSITE the hinge —
  // the side you actually pull, standard door hardware placement.
  // ASSUMPTION, not yet visually verified: LOCAL X's positive
  // direction is the same side computeBoundaryRectangle calls
  // "right" (the side hinge:'right' refers to — see
  // shared/frontFit.js#edgeSides). If the handle renders on the SAME
  // side as the hinge instead of opposite, flip sideSign's two
  // branches below.
  const sideSign = node.hinge === 'right' ? -1 : 1; // hinge 'right' (opening swings from the right) -> handle on the LEFT; hinge 'left' (default) -> handle on the RIGHT
  // Clamped to [0, width/2 - crossSection/2] — a pathologically narrow
  // door (narrower than 2x the margin) would otherwise push the
  // handle's offset negative, flipping it onto the WRONG side instead
  // of just sitting closer to center than DOOR_HANDLE_EDGE_MARGIN_MM
  // intended.
  const maxOffset = node.width / 2 - dims.crossSection / 2;
  const desiredOffset = node.width / 2 - DOOR_HANDLE_EDGE_MARGIN_MM - dims.crossSection / 2;
  const xOffset = sideSign * Math.max(0, Math.min(desiredOffset, maxOffset));
  return { localOffset: { x: xOffset, y: 0, z: zOffset }, dims, axis: 'y' };
}

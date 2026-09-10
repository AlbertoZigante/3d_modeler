/**
 * shared/frontFit.js
 *
 * Shared geometry math for anything that fits new panel(s) into a
 * rectangular opening bounded by 4 already-picked panels (see
 * tools/boundaryRectTool.js + this file's own computeBoundaryRectangle
 * import) — the "front-fitting" problem. features/door.js (one door)
 * and features/drawer.js (N stacked drawer fronts) both reduce to the
 * exact same sub-problem: given an edgeFit (in/out per edge) and a
 * thickness, work out (a) the new front's own footprint across
 * axisA/axisB, (b) how each of the 4 boundary panels needs to
 * recede/extend to meet it without gaps or interpenetration, and (c)
 * which OTHER (non-boundary) panels in the group — a shelf spanning
 * straight across the opening, say — now physically overlap the new
 * front's own slab and need to recede too.
 *
 * Extracted from features/door.js (which used to do all of this
 * inline in computeDoorPlacement) so a fix to one — see the interior-
 * clearance pass below, originally added to stop a shelf penetrating
 * a door — can never silently drift out of sync between door and
 * drawer. door.js's own behavior is unchanged by this extraction; it
 * now just calls computeFrontFit() and layers door-specific fields
 * (hinge, doorSign) on top.
 */
import { getAlignedAxis, MIN_PANEL_DIM_MM } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';
import { panelExtentAlongAxis, PARALLEL_ROTATION, VERTICAL_ROTATION, HORIZONTAL_ROTATION } from './geometry.js';

export const DEFAULT_FRONT_EDGE_FIT = { left: 'in', right: 'in', bottom: 'in', top: 'in' };

// A front's normalAxis (whichever wall it's replacing) determines its
// own rotation the same way for a door or a drawer front — 'z'
// (replacing Back/Front) lies PARALLEL_ROTATION, 'x' (replacing
// Left/Right) is VERTICAL_ROTATION, 'y' (replacing Top/Bottom) is
// HORIZONTAL_ROTATION. Shared here instead of duplicated in both
// features/door.js and features/drawer.js.
export const ROTATION_FOR_NORMAL_AXIS = { z: PARALLEL_ROTATION, x: VERTICAL_ROTATION, y: HORIZONTAL_ROTATION };

// Which of a node's own width/height/thickness fields actually
// governs a given world axis, for a given rotation — e.g. for
// VERTICAL_ROTATION (Left/Right-style), 'width' governs Z and
// 'height' governs Y, not the other way round (see FACE_TO_DIM_FIELD
// in modules.js: 'right' face -> width, 'top' face -> height). Reused
// here instead of hardcoding a per-rotation table so this stays
// correct if LOCAL_FACES/getAlignedAxis's own convention ever changes.
export function dimFieldForAxis(rotation, axis) {
  if (getAlignedAxis(rotation, 'right')?.axis === axis) return 'width';
  if (getAlignedAxis(rotation, 'top')?.axis === axis) return 'height';
  return 'thickness';
}

// Maps computeBoundaryRectangle's axisA/axisB near/far sides onto the
// stable left/right/bottom/top edge labels every front-fit edgeFit
// (a door's or a drawer stack's) uses.
export function edgeSides(boundaryResult) {
  const a = boundaryResult.sides[boundaryResult.axisA];
  const b = boundaryResult.sides[boundaryResult.axisB];
  return { left: a.near, right: a.far, bottom: b.near, top: b.far };
}

/**
 * @param {Array} panels - current graph (passed to resolveConstraints)
 * @param {Object} boundaryResult - a successful (ok:true) result from
 *   shared/geometry.js#computeBoundaryRectangle (the 4-panel pick)
 * @param {{left:'in'|'out',right:'in'|'out',bottom:'in'|'out',top:'in'|'out'}} edgeFit
 * @param {number} thicknessMm - the new front's own thickness
 * @returns {{ ok: true, groupId: string, normalAxis: string, axisA: string, axisB: string,
 *   aMin: number, aMax: number, bMin: number, bMax: number,
 *   outerFaceN: number, innerFaceN: number, centerN: number, sign: 1|-1,
 *   edgeFit: Object, boundaryIds: Object,
 *   panelPatches: [{ id: string, dimField: string, oldMin: number, oldMax: number, newMin: number, newMax: number, centerN: number }] }
 *  | { ok: false, reason: 'invalid-boundary-result' | 'not-resolved' | 'degenerate' | 'panel-too-short' }}
 */
export function computeFrontFit(panels, boundaryResult, edgeFit, thicknessMm) {
  if (!boundaryResult || !boundaryResult.ok) return { ok: false, reason: 'invalid-boundary-result' };

  const N = boundaryResult.normalAxis;
  const fit = { ...DEFAULT_FRONT_EDGE_FIT, ...(edgeFit || {}) };
  const sides = edgeSides(boundaryResult);

  // The front's own footprint across the 2 bounded axes — 'out'
  // reaches to that side's OUTER rect edge (covering the boundary
  // panel); 'in' stays at the INNER rect edge (flush inside it).
  // Already computed by computeBoundaryRectangle — no need to
  // re-derive xInnerMin-style bounds here.
  const aMin = fit.left === 'out' ? boundaryResult.outer[boundaryResult.axisA].min : boundaryResult.inner[boundaryResult.axisA].min;
  const aMax = fit.right === 'out' ? boundaryResult.outer[boundaryResult.axisA].max : boundaryResult.inner[boundaryResult.axisA].max;
  const bMin = fit.bottom === 'out' ? boundaryResult.outer[boundaryResult.axisB].min : boundaryResult.inner[boundaryResult.axisB].min;
  const bMax = fit.top === 'out' ? boundaryResult.outer[boundaryResult.axisB].max : boundaryResult.inner[boundaryResult.axisB].max;
  if (aMax <= aMin || bMax <= bMin) return { ok: false, reason: 'degenerate' };

  const resolved = resolveConstraints(panels);
  const findResolved = (node) => resolved.find((r) => r.id === node.id);

  // Each boundary panel's current extent along N (the front's own
  // normal/facing axis), and which edge label (hence which fit) it
  // corresponds to.
  const extents = Object.entries(sides).map(([edge, node]) => {
    const r = findResolved(node);
    const extent = r && panelExtentAlongAxis(r, N);
    return extent ? { edge, node: r, ...extent } : null;
  });
  if (extents.some((e) => !e)) return { ok: false, reason: 'not-resolved' };

  // The structure's current outward-facing opening along N: whichever
  // face (across all 4 panels) sits farthest from the box's shared
  // anchor (offset 0 on that axis) — i.e. the side that's presumably
  // open, not already backed by another wall. This is a heuristic,
  // not a guarantee: if a front is ever needed on the OTHER side of an
  // already-enclosed opening, that needs its own explicit direction
  // control, which nothing built so far requires.
  const farthestMax = Math.max(...extents.map((e) => e.max));
  const farthestMin = Math.min(...extents.map((e) => e.min));
  const facesPositive = Math.abs(farthestMax) >= Math.abs(farthestMin);
  const outerFaceN = facesPositive ? farthestMax : farthestMin;
  const sign = facesPositive ? 1 : -1; // which way the front's own outer face points, away from the boundary panels

  const centerN = outerFaceN - sign * (thicknessMm / 2);
  const innerFaceN = outerFaceN - sign * thicknessMm;

  // Each boundary panel recedes by the front's own thickness on the
  // end facing it when that edge's fit is 'out' (the front now covers
  // that end); stays exactly flush with the front's INNER face when
  // 'in' (the panel extends/shrinks to meet the front exactly,
  // whatever its previous extent was — same "flip it and the wall
  // adapts" rule box.js's depthRangeFor already established).
  const panelPatches = extents.map(({ edge, node, dimField, min, max }) => {
    const facingIsMaxEnd = sign > 0; // the panel's end pointing toward the front is its `max` end when the front sits on the +N side, `min` end otherwise
    const otherEnd = facingIsMaxEnd ? min : max;
    const newFacingEnd = fit[edge] === 'out' ? innerFaceN : outerFaceN;
    const newMin = facingIsMaxEnd ? otherEnd : newFacingEnd;
    const newMax = facingIsMaxEnd ? newFacingEnd : otherEnd;
    return { id: node.id, dimField, oldMin: min, oldMax: max, newMin, newMax, centerN: (newMin + newMax) / 2 };
  });

  // INTERIOR panels — anything in this box that is NOT one of the 4
  // boundary panels above (typically a shelf) but happens to overlap
  // the front's own footprint in the two in-plane axes (axisA/axisB).
  // A shelf's depth constraint (features/shelf.js#addShelf's
  // spanToDepth) reaches all the way to the box's actual Back/Front
  // wall nodes directly — it has no idea a door or drawer front might
  // later cover that opening, so it keeps reaching to Front's own
  // inner face, one front-thickness short of where it actually needs
  // to stop. Left/Right/Top/Bottom don't have this problem even
  // though they reach the same far point: they're the front's own
  // boundary panels, sitting BESIDE its footprint in axisA/axisB,
  // never inside it, so they never actually share 3D space with the
  // front the way a shelf spanning straight across the opening does.
  // Detected here via genuine 3D overlap (not by name/type), so it
  // applies equally to a door, a drawer front, or anything else ever
  // placed running through an opening's footprint.
  // KNOWN LIMITATION: the resulting patch gets applied via
  // features/door.js#applyPanelPatch, whose constraint-offset branch
  // assumes `from` anchors the constrained field's MIN end and `to`
  // its MAX end — true for a shelf's spanToDepth (from=Back, to=Front,
  // and Back is always more negative than Front by construction) for
  // a Front/Back-replacing front (normalAxis 'z', the case this was
  // built for). A front that instead replaces Left/Right/Top/Bottom
  // (normalAxis 'x'/'y') could in principle find a shelf penetrating
  // it via spanToBoundaries instead — that constraint's from/to
  // ordering isn't guaranteed the same way, so a patch generated for
  // it here could shrink the wrong end. Not solved speculatively — no
  // door or drawer built so far replaces a side/top/bottom wall over a
  // shelf that spans across it.
  const boundaryPanelIds = new Set(extents.map((e) => e.node.id));
  const EPS = 0.01; // mm — avoids false positives from panels merely touching the front's outer face, not actually overlapping it
  // isDoor/isDrawerFront aren't in resolveConstraints' field whitelist
  // (see modeller/snap.js — only id/name/material/.../groupId/hidden/
  // width/height/thickness/basePosition/position/lockedFields
  // survive), so an EXISTING door or drawer front being recomputed
  // (already sitting in `panels`) can't be filtered out via `resolved`
  // alone — check the raw node instead.
  const rawById = new Map(panels.map((p) => [p.id, p]));
  const clearancePatches = resolved
    .filter((r) => r.groupId === boundaryResult.groupId && !r.hidden && !boundaryPanelIds.has(r.id)
      && !rawById.get(r.id)?.isDoor && !rawById.get(r.id)?.isDrawerFront)
    .map((r) => {
      const extentN = panelExtentAlongAxis(r, N);
      const extentA = panelExtentAlongAxis(r, boundaryResult.axisA);
      const extentB = panelExtentAlongAxis(r, boundaryResult.axisB);
      if (!extentN || !extentA || !extentB) return null; // defensive — every panel here is axis-aligned to all 3 axes

      const overlapsFootprint = extentA.max > aMin + EPS && extentA.min < aMax - EPS
        && extentB.max > bMin + EPS && extentB.min < bMax - EPS;
      if (!overlapsFootprint) return null; // e.g. Left/Right/Top/Bottom — beside the opening, never sharing space with the front

      const penetrates = sign > 0 ? extentN.max > innerFaceN + EPS : extentN.min < innerFaceN - EPS;
      if (!penetrates) return null; // already clear of the front's own slab — nothing to do

      const newMin = sign > 0 ? extentN.min : innerFaceN;
      const newMax = sign > 0 ? innerFaceN : extentN.max;
      return { id: r.id, dimField: extentN.dimField, oldMin: extentN.min, oldMax: extentN.max, newMin, newMax, centerN: (newMin + newMax) / 2 };
    })
    .filter(Boolean);

  const allPatches = [...panelPatches, ...clearancePatches];
  if (allPatches.some((p) => p.newMax - p.newMin < MIN_PANEL_DIM_MM)) {
    return { ok: false, reason: 'panel-too-short' };
  }

  return {
    ok: true,
    groupId: boundaryResult.groupId,
    normalAxis: N,
    axisA: boundaryResult.axisA,
    axisB: boundaryResult.axisB,
    aMin, aMax, bMin, bMax,
    outerFaceN, innerFaceN, centerN,
    sign,
    edgeFit: fit, // the fully-defaulted fit actually used — callers store this on their node(s) so a later recompute reuses the SAME fit rather than falling back to DEFAULT_FRONT_EDGE_FIT
    // The 4 boundary panels' own ids, keyed the same way `sides` is —
    // callers store these on their node(s) so a later relayout
    // (features/box.js#relayoutBox) can look the SAME 4 panels back up
    // and recompute this front from scratch against their new
    // geometry, instead of the front being frozen at whatever it was
    // computed as the moment it was created.
    boundaryIds: Object.fromEntries(Object.entries(sides).map(([edge, node]) => [edge, node.id])),
    // Boundary-panel patches first, then interior-clearance patches
    // (shelves, etc.) — order doesn't matter for correctness (each
    // patch targets a different node id and applyPanelPatch looks up
    // its own node fresh every call), kept in this order just because
    // it reads naturally: the opening itself, then what's inside it.
    panelPatches: allPatches,
  };
}

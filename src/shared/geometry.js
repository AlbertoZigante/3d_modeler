/**
 * shared/geometry.js
 *
 * Generic geometry/validation helpers shared by box, shelf, and
 * collinear — none of this should know what a "box" or "shelf" is.
 */
import { computeWorldHalfExtents, DESIGN_LIMITS_MM, PANEL_SIZE_LIMITS_MM, LOCAL_FACES, FACE_TO_DIM_FIELD, getAlignedAxis } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';

// Orientation is decided at creation time, not via a post-creation
// toggle — see the Vertical/Horizontal/Parallel buttons in the panel
// list. VERTICAL matches createPanelNode's own default rotation (a
// standing divider in the YZ plane); HORIZONTAL matches what the old
// Vertical/Horizontal inspector toggle produced for a flat shelf;
// PARALLEL is identity rotation — face lies in the XY plane,
// thickness along Z, same orientation the box preset uses for its
// 'back' panel. Unlike the other two, a Parallel panel shows its full
// face (not an edge-on sliver) in the 2D front view, and both its
// width and height are 2D-edge-draggable there — see view2d.js, which
// derives this from rotation directly via getAlignedAxis rather than
// a hardcoded Vertical/Horizontal check.
export const VERTICAL_ROTATION = { x: 0, y: 90, z: 0 };
export const HORIZONTAL_ROTATION = { x: 90, y: 0, z: 0 };
export const PARALLEL_ROTATION = { x: 0, y: 0, z: 0 };

export const MIN_WALL_GAP_MM = 15;

export function rotationsMatch(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

// Sorts a set of same-axis slabs (each { center, halfThickness,
// label }) and checks every neighbor pair keeps at least
// MIN_WALL_GAP_MM of clear space between them. Walls and shelves are
// indistinguishable here — a wall is just a slab that happens to also
// be getting relaid-out this call.
export function checkMinGap(elements) {
  const sorted = [...elements].sort((a, b) => a.center - b.center);
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = (sorted[i + 1].center - sorted[i + 1].halfThickness) - (sorted[i].center + sorted[i].halfThickness);
    if (gap < MIN_WALL_GAP_MM) {
      return { ok: false, a: sorted[i].label, b: sorted[i + 1].label };
    }
  }
  return { ok: true };
}

// Builds the full set of same-axis slabs for a box — the two bounding
// walls (Bottom/Top for axis 'y', Left/Right for axis 'x') plus every
// shelf sharing that axis (horizontal shelves live on 'y', vertical
// on 'x') — with `overrides` swapping in a PROPOSED value for
// whichever element is currently being dragged/resized/created.
// `overrides` maps nodeId -> {center, halfThickness, label}; the
// special key '__new__' holds a not-yet-created candidate (used by
// addShelf's pre-creation check, where there's no id yet). This is
// the one place that knows "what counts as a slab on this axis" —
// wall drags, shelf drags, and shelf creation all go through it.
//
// Takes `panels` explicitly — this module has no access to any live
// graph state of its own, callers (box.js, shelf.js, modeller-main.js)
// always pass their current panels array.
export function collectAxisSlabs(panels, groupId, axis, overrides = {}) {
  const relevantRotation = axis === 'y' ? HORIZONTAL_ROTATION : VERTICAL_ROTATION;
  const wallRoleLow = axis === 'y' ? 'Bottom' : 'Left';
  const wallRoleHigh = axis === 'y' ? 'Top' : 'Right';

  const slabs = [];
  panels.forEach((p) => {
    if (p.groupId !== groupId) return;
    if (p.hidden) return; // a hidden (removed-but-restorable) panel no longer occupies space — see removeSelected()
    const isRelevantWall = p.isBoxWall && (p.name === wallRoleLow || p.name === wallRoleHigh);
    const isRelevantShelf = !p.isBoxWall && rotationsMatch(p.rotation, relevantRotation);
    if (!isRelevantWall && !isRelevantShelf) return;
    const o = overrides[p.id];
    slabs.push(
      o
        ? { center: o.center, halfThickness: o.halfThickness, label: o.label || p.name || 'Shelf' }
        : { center: p.offset[axis], halfThickness: p.thickness / 2, label: p.name || 'Shelf' }
    );
  });
  if (overrides.__new__) slabs.push(overrides.__new__);
  return slabs;
}

// Move-drags: clamps the PROPOSED offset per axis against the panel's
// own true world-space size (computeWorldHalfExtents accounts for
// rotation — a Horizontal panel's thickness is what extends along Z,
// not its width). basePosition never changes, so it's always the
// correct zero-offset reference to clamp relative to.
export function clampOffsetToDesignLimits(node, proposedOffset) {
  const halfExtents = computeWorldHalfExtents(node);
  const base = node.basePosition;
  const clamped = { ...proposedOffset };
  let hitAxis = null;
  ['x', 'y', 'z'].forEach((axis) => {
    const limit = DESIGN_LIMITS_MM[axis];
    const minAbs = limit.min + halfExtents[axis];
    const maxAbs = limit.max - halfExtents[axis];
    const proposedAbs = base[axis] + (proposedOffset[axis] || 0);
    if (proposedAbs < minAbs) {
      clamped[axis] = minAbs - base[axis];
      hitAxis = axis;
    } else if (proposedAbs > maxAbs) {
      clamped[axis] = maxAbs - base[axis];
      hitAxis = axis;
    }
  });
  return { offset: clamped, hitAxis };
}

// Group move-drags: like clampOffsetToDesignLimits above, but for a
// RIGID multi-member move. Finds each member's own allowed per-axis
// delta range (from its own world half-extents and drag-start
// position), intersects those ranges across every member to get the
// single most restrictive range for the whole group, then clamps the
// proposed delta to THAT — so all members are held to the exact same
// reduced delta and the group never loses its rigidity at the
// boundary (as opposed to each member independently clamping to its
// own limit and drifting apart from the others).
export function clampGroupOffsetToDesignLimits(members, startOffsets, proposedDeltaMm) {
  const clamped = { ...proposedDeltaMm };
  let hitAxis = null;
  ['x', 'y', 'z'].forEach((axis) => {
    const limit = DESIGN_LIMITS_MM[axis];
    let groupMin = -Infinity;
    let groupMax = Infinity;
    members.forEach((node) => {
      const start = startOffsets.get(node.id);
      if (!start) return;
      const halfExtents = computeWorldHalfExtents(node);
      const baseAbs = node.basePosition[axis] + start[axis]; // this member's absolute position at drag-start (delta is applied on top of this)
      groupMin = Math.max(groupMin, limit.min + halfExtents[axis] - baseAbs);
      groupMax = Math.min(groupMax, limit.max - halfExtents[axis] - baseAbs);
    });
    const proposed = proposedDeltaMm[axis] || 0;
    if (proposed < groupMin) {
      clamped[axis] = groupMin;
      hitAxis = axis;
    } else if (proposed > groupMax) {
      clamped[axis] = groupMax;
      hitAxis = axis;
    }
  });
  return { delta: clamped, hitAxis };
}

// Resize-drags and typed fields: outright rejects if a panel's own
// width/height would exceed PANEL_SIZE_LIMITS_MM — returns the
// offending field ('width'|'height'), or null if within limits.
// Separate from findDesignLimitViolation below, which bounds the
// overall scene rather than any single panel's own dimensions.
export function findPanelSizeViolation(dims) {
  if (dims.width > PANEL_SIZE_LIMITS_MM.width) return 'width';
  if (dims.height > PANEL_SIZE_LIMITS_MM.height) return 'height';
  return null;
}

// Resize-drags and typed fields: outright rejects if the FINAL
// position + dimensions would violate any axis — returns the
// offending axis, or null if the edit is fine as proposed.
export function findDesignLimitViolation(rotation, positionMm, dims) {
  const halfExtents = computeWorldHalfExtents({ rotation, ...dims });
  for (const axis of ['x', 'y', 'z']) {
    const limit = DESIGN_LIMITS_MM[axis];
    const min = positionMm[axis] - halfExtents[axis];
    const max = positionMm[axis] + halfExtents[axis];
    if (min < limit.min - 0.01 || max > limit.max + 0.01) return axis;
  }
  return null;
}

// Which of a resolved node's LOCAL faces both (a) aligns with `axis`
// and (b) points TOWARD `otherResolved` — i.e. the one face of the
// two possible (+/-) candidates that actually faces the other picked
// boundary, determined from their real current positions rather than
// assumed from role/name. MOVED here from features/shelf.js (was
// local/unexported there) since shelf.js's addShelf and
// computeBoundaryRectangle below both need the exact same "which face
// faces which" logic — this is what lets picking an existing shelf as
// a boundary work exactly like picking Left/Right/Top/Bottom, in both
// places, without duplicating the math.
export function facingFace(resolved, axis, otherResolved) {
  const towardSign = Math.sign(otherResolved.position[axis] - resolved.position[axis]) || 1;
  for (const faceName of Object.keys(LOCAL_FACES)) {
    const aligned = getAlignedAxis(resolved.rotation, faceName);
    if (aligned && aligned.axis === axis && aligned.sign === towardSign) return faceName;
  }
  return null; // defensive — every panel in this app is axis-aligned, so one of the two candidate faces always matches
}

// Given an already-resolved node and a world axis, finds which of its
// LOCAL faces point toward +axis and -axis (every panel in this app
// is axis-aligned, so exactly one of each exists) and returns that
// axis's current extent — min/max positions plus which raw field
// (width/height/thickness) actually governs it. Unlike facingFace
// above (which needs a second node to know WHICH of the two candidate
// faces is being asked about), this doesn't care about any other
// panel — it just reports the node's own footprint along one axis.
// Used by features/door.js to work out where a NEW door's 4 boundary
// panels currently end along the door's own normal axis, so they can
// be resized to meet it without gaps or interpenetration.
export function panelExtentAlongAxis(resolved, axis) {
  let posFace = null, negFace = null;
  for (const faceName of Object.keys(LOCAL_FACES)) {
    const aligned = getAlignedAxis(resolved.rotation, faceName);
    if (aligned && aligned.axis === axis) {
      if (aligned.sign > 0) posFace = faceName;
      else negFace = faceName;
    }
  }
  if (!posFace || !negFace) return null; // defensive — every panel has both faces of a pair aligned to any given axis it's aligned to at all

  const dimField = FACE_TO_DIM_FIELD[posFace]; // same field for both faces of an opposite pair — see FACE_TO_DIM_FIELD in modules.js
  const half = resolved[dimField] / 2;
  return {
    dimField,
    posFace, // the face pointing toward +axis
    negFace, // the face pointing toward -axis
    min: resolved.position[axis] - half,
    max: resolved.position[axis] + half,
  };
}
// Left/Right wall (or an existing vertical shelf) bounds the X axis;
// Top/Bottom (or an existing horizontal shelf) bounds Y; Back/Front
// bounds Z. Shelves only ever exist as VERTICAL_ROTATION or
// HORIZONTAL_ROTATION (see features/shelf.js#isShelf), so a Z-axis
// boundary pick can only ever be an actual Back/Front box wall — that
// asymmetry is fine and expected, not special-cased here. Exported so
// tools/boundaryRectTool.js validates picks against this exact same
// vocabulary instead of a second copy.
export const BOUNDARY_ROTATION_BY_AXIS = { x: VERTICAL_ROTATION, y: HORIZONTAL_ROTATION, z: PARALLEL_ROTATION };

export const OPPOSITE_FACE = { right: 'left', left: 'right', top: 'bottom', bottom: 'top', front: 'back', back: 'front' };

// Given the 2 same-axis boundary nodes (raw graph nodes) and a
// resolved-node lookup, finds which face of each faces the other
// (via facingFace above) and returns where the resulting INNER edge
// (the two facing faces — the clear opening) and OUTER edge (the two
// far/outward faces) sit along `axis`, in absolute mm — plus the
// actual face names involved, so a calling feature can build
// spansBetween constraints against them directly (same shape
// features/shelf.js#addShelf already builds its own spansToBoundaries
// from) instead of re-deriving facingFace itself.
function computeAxisEdges(findResolved, nodeA, nodeB, axis) {
  const rA = findResolved(nodeA);
  const rB = findResolved(nodeB);
  if (!rA || !rB) return null;

  const faceA = facingFace(rA, axis, rB);
  const faceB = facingFace(rB, axis, rA);
  if (!faceA || !faceB) return null;

  const signA = getAlignedAxis(rA.rotation, faceA).sign;
  const signB = getAlignedAxis(rB.rotation, faceB).sign;
  const dimA = rA[FACE_TO_DIM_FIELD[faceA]];
  const dimB = rB[FACE_TO_DIM_FIELD[faceB]];

  const innerA = rA.position[axis] + signA * (dimA / 2);
  const innerB = rB.position[axis] + signB * (dimB / 2);
  const outerA = rA.position[axis] - signA * (dimA / 2);
  const outerB = rB.position[axis] - signB * (dimB / 2);

  const aIsNear = innerA <= innerB; // the node whose inner face sits at the smaller mm coordinate
  const nearInwardFace = aIsNear ? faceA : faceB;
  const farInwardFace = aIsNear ? faceB : faceA;
  return {
    innerMin: Math.min(innerA, innerB),
    innerMax: Math.max(innerA, innerB),
    outerMin: Math.min(outerA, outerB),
    outerMax: Math.max(outerA, outerB),
    nearNode: aIsNear ? nodeA : nodeB,
    farNode: aIsNear ? nodeB : nodeA,
    nearInwardFace,
    farInwardFace,
    nearOutwardFace: OPPOSITE_FACE[nearInwardFace],
    farOutwardFace: OPPOSITE_FACE[farInwardFace],
  };
}

// Builds the axis-keyed rect object for either 'inner' or 'outer' —
// see computeBoundaryRectangle's own doc for why the keys are the
// actual world axis letters ('x'/'y'/'z') rather than fixed
// left/right/width/height names: which two axes are bounded (and
// which one is the new panel's own facing/normal direction) changes
// depending on which wall the new door/front is replacing.
function rectFromAxes(axisA, edgesA, axisB, edgesB, which) {
  const aMin = edgesA[`${which}Min`], aMax = edgesA[`${which}Max`];
  const bMin = edgesB[`${which}Min`], bMax = edgesB[`${which}Max`];
  return {
    [axisA]: { min: aMin, max: aMax },
    [axisB]: { min: bMin, max: bMax },
    size: { [axisA]: aMax - aMin, [axisB]: bMax - bMin },
    center: { [axisA]: (aMin + aMax) / 2, [axisB]: (bMin + bMax) / 2 },
  };
}

/**
 * Given exactly 4 user-picked panel nodes (box walls or shelves),
 * computes the rectangular opening they bound — the shared math
 * behind any feature whose front section must fit a rectangular shape
 * (doors, drawer fronts, shelf fronts). Those features call this
 * instead of each re-deriving "which panel is which side" and "where
 * do the facing faces land" on their own.
 *
 * NOT hardcoded to the box's front (XY) plane — the 4 panels must
 * bound exactly TWO of the three possible axes (see
 * BOUNDARY_ROTATION_BY_AXIS above: X via Left/Right-type panels, Y via
 * Top/Bottom-type, Z via Back/Front-type), two panels per axis. The
 * THIRD axis (not bounded by any of the 4 picks) is `normalAxis` —
 * the direction the new door/front's own face will point:
 *
 *   - Pick 2 Left/Right(-type) + 2 Top/Bottom(-type)  -> normalAxis
 *     'z': the ordinary FRONT door/shelf-front case (faces the box's
 *     opening, like the box's own Front wall).
 *   - Pick 2 Top/Bottom(-type) + 2 Back/Front(-type)  -> normalAxis
 *     'x': a door that REPLACES the Left or Right wall instead.
 *   - Pick 2 Left/Right(-type) + 2 Back/Front(-type)  -> normalAxis
 *     'y': a door that replaces the Top or Bottom wall instead.
 *
 * Returns both the INNER rectangle (between the 4 panels' facing
 * faces — the clear opening an INSET door/front must fit inside) and
 * the OUTER rectangle (between their outward faces — what a full-
 * OVERLAY door/front would cover, panel thickness included). Both are
 * in absolute mm, in the same coordinate space resolveConstraints()
 * returns, keyed by the two bounded axis letters (see rectFromAxes) —
 * e.g. for the ordinary front case that's `inner.x` / `inner.y`; for
 * a Left-wall replacement it's `inner.y` / `inner.z`.
 *
 * @param {Array} panels - current graph (passed to resolveConstraints)
 * @param {[Object,Object,Object,Object]} pickedPanels - the 4 raw
 *   panel nodes from user selection, in any order
 * @returns {{ ok: true, groupId: string, axisA: string, axisB: string, normalAxis: string,
 *   sides: { [axis: string]: { near: Object, far: Object, nearFace: string, farFace: string } },
 *   inner: { [axis: string]: {min,max}, size: {...}, center: {...} },
 *   outer: { [axis: string]: {min,max}, size: {...}, center: {...} } }
 *  | { ok: false, reason: 'wrong-count' | 'mixed-box' | 'not-boundary' | 'not-resolved' | 'degenerate' }}
 */
export function computeBoundaryRectangle(panels, pickedPanels) {
  if (!pickedPanels || pickedPanels.length !== 4) return { ok: false, reason: 'wrong-count' };

  const groupId = pickedPanels[0].groupId;
  if (!groupId || pickedPanels.some((p) => p.groupId !== groupId)) {
    return { ok: false, reason: 'mixed-box' };
  }

  const byAxis = { x: [], y: [], z: [] };
  for (const p of pickedPanels) {
    const axis = Object.keys(BOUNDARY_ROTATION_BY_AXIS).find((a) => rotationsMatch(p.rotation, BOUNDARY_ROTATION_BY_AXIS[a]));
    if (!axis) return { ok: false, reason: 'not-boundary' };
    byAxis[axis].push(p);
  }
  const usedAxes = ['x', 'y', 'z'].filter((a) => byAxis[a].length > 0);
  if (usedAxes.length !== 2 || byAxis[usedAxes[0]].length !== 2 || byAxis[usedAxes[1]].length !== 2) {
    return { ok: false, reason: 'not-boundary' };
  }
  const [axisA, axisB] = usedAxes;
  const normalAxis = ['x', 'y', 'z'].find((a) => a !== axisA && a !== axisB);

  const resolved = resolveConstraints(panels);
  const findResolved = (node) => resolved.find((r) => r.id === node.id);

  const edgesA = computeAxisEdges(findResolved, byAxis[axisA][0], byAxis[axisA][1], axisA);
  const edgesB = computeAxisEdges(findResolved, byAxis[axisB][0], byAxis[axisB][1], axisB);
  if (!edgesA || !edgesB) return { ok: false, reason: 'not-resolved' };

  if (edgesA.innerMax <= edgesA.innerMin || edgesB.innerMax <= edgesB.innerMin) {
    return { ok: false, reason: 'degenerate' };
  }

  return {
    ok: true,
    groupId,
    axisA, axisB, normalAxis,
    sides: {
      [axisA]: { near: edgesA.nearNode, far: edgesA.farNode, nearFace: edgesA.nearInwardFace, farFace: edgesA.farInwardFace },
      [axisB]: { near: edgesB.nearNode, far: edgesB.farNode, nearFace: edgesB.nearInwardFace, farFace: edgesB.farInwardFace },
    },
    inner: rectFromAxes(axisA, edgesA, axisB, edgesB, 'inner'),
    outer: rectFromAxes(axisA, edgesA, axisB, edgesB, 'outer'),
  };
}

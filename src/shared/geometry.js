/**
 * shared/geometry.js
 *
 * Generic geometry/validation helpers shared by box, shelf, and
 * collinear — none of this should know what a "box" or "shelf" is.
 */
import { computeWorldHalfExtents, DESIGN_LIMITS_MM, PANEL_SIZE_LIMITS_MM } from '../modeller/modules.js';

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

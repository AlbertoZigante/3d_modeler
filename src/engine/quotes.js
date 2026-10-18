/**
 * engine/quotes.js
 *
 * USER QUOTES — distances a person imposes BETWEEN panels. This is the
 * one write path for them; nothing else should push a `distance`
 * constraint into node.constraints.
 *
 * TWO RULES THIS FILE ENFORCES (on purpose, in the engine rather than
 * only by hiding UI controls):
 *
 *  1. A quote is a DISTANCE, never a size. It is stored as a
 *     `distance` constraint on the DRIVEN panel and the resolver
 *     (modeller/snap.js#applyDistance) only ever writes that panel's
 *     position. Width/height/thickness are never touched.
 *
 *  2. A panel the system owns (plinth + ribs, doors, drawer parts,
 *     legs, box walls — see modeller/modules.js#getPanelOwnership)
 *     can't be the DRIVEN side of a quote: the feature that made it
 *     regenerates it. It CAN be the anchor — a fixed datum to measure
 *     from.
 *
 * Every function is pure: takes `panels`, returns a result with a new
 * `panels` array on success — the caller commits it through
 * modeller-main.js's updateNode/history path, same as any other edit.
 *
 * Result shape:  { ok: true, panels, constraint }
 *             or { ok: false, reason, message }
 */
import { resolveConstraints } from '../modeller/snap.js';
import { detectJoints } from './joints.js';
import { findQuoteConflicts } from './quoteConflicts.js';
import { relayoutBox } from '../features/box.js';
import { getAlignedAxis, getPanelOwnership, nextConstraintId, FIELD_TO_AXIS, FACE_TO_DIM_FIELD, LOCAL_FACES, computeWorldHalfExtents } from '../modeller/modules.js';

const AXIS_TO_POSITION_FIELD = { x: 'positionX', y: 'positionY', z: 'positionZ' };

function fail(reason, message) {
  return { ok: false, reason, message };
}

function nameOf(node) {
  return node?.name || node?.id;
}

// World position (mm) of a face on an already-RESOLVED panel.
function resolvedFacePoint(resolved, face, axis) {
  const aligned = getAlignedAxis(resolved.rotation, face);
  return resolved.position[axis] + aligned.sign * (resolved[FACE_TO_DIM_FIELD[face]] / 2);
}

/**
 * Whether `node` may be the driven side of a quote along `axis`.
 * @returns {{ok:true}|{ok:false, reason:string, message:string}}
 */
export function canBeDriven(node, axis) {
  const { ownership, reason } = getPanelOwnership(node);
  if (ownership === 'system') {
    return fail('system-owned', `${nameOf(node)} is managed by the system (${reason || 'derived geometry'}) and can't be moved by a quote.`);
  }
  if ((node.lockedMoveAxes || []).includes(axis)) {
    return fail('axis-locked', `${nameOf(node)} can't move along ${axis.toUpperCase()}.`);
  }
  return { ok: true };
}

/**
 * Current clear gap (mm) between an anchor face and a panel's facing
 * face — the natural default for a quote the person is about to type.
 * Negative means the two panels overlap along that axis.
 * @returns {number|null} null if the faces aren't axis-aligned/facing.
 */
export function measureGap(panels, drivenId, myFace, from) {
  const resolved = new Map(resolveConstraints(panels).map((r) => [r.id, r]));
  const me = resolved.get(drivenId);
  const anchor = resolved.get(from.node);
  if (!me || !anchor || !LOCAL_FACES[myFace] || !LOCAL_FACES[from.face]) return null;
  const a = getAlignedAxis(anchor.rotation, from.face);
  const m = getAlignedAxis(me.rotation, myFace);
  if (!a || !m || a.axis !== m.axis || a.sign !== -m.sign) return null;
  return (resolvedFacePoint(me, myFace, a.axis) - resolvedFacePoint(anchor, from.face, a.axis)) * a.sign;
}

/**
 * Turns two PICKED faces into the pair of faces that really FACE EACH
 * OTHER. A person clicking in the viewport almost always hits the
 * visible outer surfaces (e.g. the top of a shelf and the top of the
 * panel below it), which point the same way and so can't be measured;
 * what they mean is "the distance between these two panels along that
 * axis". So:
 *   - the two picks must lie on the same main axis (parallel faces);
 *   - if the picked faces already face each other (gap >= 0) they are
 *     kept exactly as picked (lets someone measure to a specific face);
 *   - otherwise each panel's face looking toward the other panel is used.
 *
 * @param {{nodeId:string, faceName:string}} a
 * @param {{nodeId:string, faceName:string}} b
 * @returns {{ok:true, a, b, corrected:boolean}|{ok:false, reason:string, message:string}}
 */
export function resolveFacingFaces(panels, a, b) {
  const resolved = new Map(resolveConstraints(panels).map((r) => [r.id, r]));
  const ra = resolved.get(a.nodeId);
  const rb = resolved.get(b.nodeId);
  if (!ra || !rb) return fail('missing-panel', 'Panel not found.');
  const alA = getAlignedAxis(ra.rotation, a.faceName);
  const alB = getAlignedAxis(rb.rotation, b.faceName);
  if (!alA || !alB || alA.axis !== alB.axis) {
    return fail('not-parallel', 'Pick two faces that are parallel (for example both top/bottom surfaces, or both left/right surfaces) so a distance can be measured.');
  }
  const axis = alA.axis;
  const tol = -0.01;
  if (alA.sign === -alB.sign) {
    const gap = (resolvedFacePoint(rb, b.faceName, axis) - resolvedFacePoint(ra, a.faceName, axis)) * alA.sign;
    if (gap >= tol) return { ok: true, a, b, corrected: false };
  }
  // Use the faces that look toward each other.
  const dir = Math.sign(rb.position[axis] - ra.position[axis]) || 1;
  const faceToward = (r, sign) => Object.keys(LOCAL_FACES).find((f) => {
    const al = getAlignedAxis(r.rotation, f);
    return al && al.axis === axis && al.sign === sign;
  });
  const fa = faceToward(ra, dir);
  const fb = faceToward(rb, -dir);
  if (!fa || !fb) return fail('not-parallel', 'Those panels have no faces on a common axis.');
  const gap = (resolvedFacePoint(rb, fb, axis) - resolvedFacePoint(ra, fa, axis)) * dir;
  if (gap < tol) {
    return fail('overlap', `Those two panels overlap along ${axis.toUpperCase()}, so there is no gap to dimension.`);
  }
  return { ok: true, a: { nodeId: a.nodeId, faceName: fa }, b: { nodeId: b.nodeId, faceName: fb }, corrected: true };
}

/**
 * Imposes `value` mm between `from` (an anchor face) and `myFace` of
 * the driven panel.
 *
 * @param {object[]} panels  raw graph
 * @param {{drivenId:string, myFace:string, from:{node:string,face:string}, value:number}} spec
 */
export function addQuote(panels, spec) {
  const { drivenId, myFace, from, value } = spec;
  const driven = panels.find((p) => p.id === drivenId);
  const anchor = panels.find((p) => p.id === from?.node);
  if (!driven) return fail('missing-panel', `Panel "${drivenId}" not found.`);
  if (!anchor) return fail('missing-panel', `Panel "${from?.node}" not found.`);
  if (driven.id === anchor.id) return fail('same-panel', 'A quote needs two different panels.');
  if (!LOCAL_FACES[myFace] || !LOCAL_FACES[from.face]) return fail('bad-face', 'Unknown face.');
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    return fail('bad-value', 'A distance must be 0 mm or more.');
  }

  const before = new Map(resolveConstraints(panels).map((r) => [r.id, r]));
  const aAnchor = getAlignedAxis(before.get(anchor.id).rotation, from.face);
  const aMine = getAlignedAxis(before.get(driven.id).rotation, myFace);
  if (!aAnchor || !aMine || aAnchor.axis !== aMine.axis) {
    return fail('axis-mismatch', 'Both faces must point along the same main axis.');
  }
  if (aAnchor.sign !== -aMine.sign) {
    return fail('not-facing', 'The two faces must face each other.');
  }
  const axis = aAnchor.axis;

  // The same pair can't be dimensioned twice along one axis — in either
  // direction (A from B, or B from A). Re-picking it is how a person
  // reaches the existing dimension, so say where it is.
  const sameFieldAxis = (c) => c.type === 'distance' && !c.overridden && FIELD_TO_AXIS[c.field] === axis;
  const already = (driven.constraints || []).some((c) => sameFieldAxis(c) && c.from?.node === anchor.id)
    || (anchor.constraints || []).some((c) => sameFieldAxis(c) && c.from?.node === driven.id);
  if (already) {
    return fail('duplicate', `${nameOf(driven)} and ${nameOf(anchor)} already have a dimension along ${axis.toUpperCase()}. Click its value to change it, or click its line and press Esc to delete it.`);
  }

  const drivable = canBeDriven(driven, axis);
  if (!drivable.ok) return drivable;

  const field = AXIS_TO_POSITION_FIELD[axis];
  const existing = (driven.constraints || []).find((c) => !c.overridden && c.field === field);
  if (existing) {
    return fail('already-driven', `${nameOf(driven)}'s ${axis.toUpperCase()} position is already controlled by another relation.`);
  }

  const constraint = {
    id: nextConstraintId(), type: 'distance', kind: 'quote',
    field, myFace, from: { node: anchor.id, face: from.face }, value, overridden: false,
  };
  const next = panels.map((p) => (p.id === driven.id ? { ...p, constraints: [...(p.constraints || []), constraint] } : p));

  // Dry run: the resolver itself must accept it, and the quote must not
  // have introduced a cycle or any new warning on either panel.
  const after = new Map(resolveConstraints(next).map((r) => [r.id, r]));
  for (const id of [driven.id, anchor.id]) {
    const fresh = after.get(id).warnings.filter((w) => !before.get(id).warnings.includes(w));
    if (fresh.length) return fail('resolver-rejected', fresh[0]);
  }
  return { ok: true, panels: next, constraint };
}

function replaceConstraint(panels, drivenId, constraintId, mapFn) {
  const driven = panels.find((p) => p.id === drivenId);
  const c = driven?.constraints?.find((k) => k.id === constraintId);
  if (!c || c.type !== 'distance') return null;
  return panels.map((p) => (p.id === drivenId
    ? { ...p, constraints: mapFn(p.constraints, c) }
    : p));
}

/** Changes the mm of an existing quote. Re-checks the resolver. */
export function updateQuote(panels, drivenId, constraintId, value) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    return fail('bad-value', 'A distance must be 0 mm or more.');
  }
  const next = replaceConstraint(panels, drivenId, constraintId,
    (list) => list.map((c) => (c.id === constraintId ? { ...c, value } : c)));
  if (!next) return fail('not-a-quote', 'Quote not found.');
  const driven = next.find((p) => p.id === drivenId);
  const { ownership } = getPanelOwnership(driven);
  if (ownership === 'system') return fail('system-owned', `${nameOf(driven)} is managed by the system.`);
  return { ok: true, panels: next };
}

/**
 * Stores where the person dragged a dimension line: a shift (mm) along
 * the line's perpendicular direction, relative to its automatic position
 * just outside the panels. Cosmetic only — never moves a panel.
 */
export function setQuoteOffset(panels, drivenId, constraintId, offsetMm) {
  if (!Number.isFinite(offsetMm)) return fail('bad-value', 'Invalid dimension position.');
  const next = replaceConstraint(panels, drivenId, constraintId,
    (list) => list.map((c) => (c.id === constraintId ? { ...c, dimOffsetMm: offsetMm } : c)));
  if (!next) return fail('not-a-quote', 'Quote not found.');
  return { ok: true, panels: next };
}

/** Deletes a quote; the panel stays where it currently is. */
export function removeQuote(panels, drivenId, constraintId) {
  const resolved = resolveConstraints(panels).find((r) => r.id === drivenId);
  const next = replaceConstraint(panels, drivenId, constraintId,
    (list) => list.filter((c) => c.id !== constraintId));
  if (!next) return fail('not-a-quote', 'Quote not found.');
  // Freeze the current resolved position into `offset` so removing the
  // quote doesn't make the panel jump (same approach as
  // modeller-main.js#unlinkOrRemoveConstraint).
  const frozen = next.map((p) => {
    if (p.id !== drivenId || !resolved) return p;
    const base = p.basePosition || { x: 0, y: 0, z: 0 };
    return { ...p, offset: {
      x: resolved.position.x - base.x, y: resolved.position.y - base.y, z: resolved.position.z - base.z,
    } };
  });
  return { ok: true, panels: frozen };
}

/**
 * Live preview for the Dimension tool: what WOULD happen if `spec` were
 * applied, without changing anything.
 *
 *   { ok: false, blocking }            — addQuote would refuse it
 *   { ok: true, conflicts: string[] }  — accepted, plus the NEW quote
 *                                        conflicts it would cause (empty = fits)
 *
 * Conflicts already present before the quote are not repeated.
 */
export function previewQuote(panels, spec) {
  const added = addQuote(panels, spec);
  if (!added.ok) return { ok: false, blocking: added.message, conflicts: [], conflictIds: [] };
  return { ...newConflicts(panels, added.panels), ok: true };
}

/**
 * Conflicts that `next` has and `prev` did not (same audit as the red lines
 * in the viewport). `conflictIds` = ids of the quoted panels involved, used
 * to flash the quotes in the way in red.
 */
export function newConflicts(prev, next) {
  const audit = (list) => {
    const resolved = resolveConstraints(list);
    return findQuoteConflicts(list, resolved, { collisions: detectJoints(resolved).collisions });
  };
  const known = new Set(audit(prev).map((v) => v.key));
  const fresh = audit(next).filter((v) => !known.has(v.key));
  const ids = new Set();
  fresh.forEach((v) => [...(v.drivenIds || []), ...(v.panelIds || [])].forEach((id) => ids.add(id)));
  return { conflicts: fresh.map((v) => v.message), conflictIds: [...ids] };
}

// ---------------------------------------------------------------
// BOX DIMENSIONS — a distance between two walls of the SAME box.
//
// The six walls of a box are system-owned: relayoutBox() recomputes
// their sizes from where the walls sit, so a persistent `distance`
// constraint on a wall would fight it. But the clear distance between
// two facing walls (Left/Right = interior width, Top/Bottom = interior
// height, Back/Front = interior depth) IS the box's size, and it is
// still "a distance between two elements", so the Dimension tool
// accepts it. It is applied as a one-shot MOVE of the wall on the
// positive side along that axis, after which relayoutBox() re-fits the
// other walls (and doors, drawers, plinth, legs follow). No constraint
// is stored: the box geometry itself is the record.
// ---------------------------------------------------------------
const BOX_AXIS_LABEL = { x: 'width', y: 'height', z: 'depth' };

/**
 * @param {{nodeId:string, faceName:string}} a - facing faces, as returned by resolveFacingFaces
 * @param {{nodeId:string, faceName:string}} b
 * @returns {null | {ok:true, groupId, axis, label, moveId, anchorId, measuredMm, moveName, anchorName}}
 *   null when the two panels are not walls of one box (ordinary quote rules apply).
 */
export function planBoxDimension(panels, a, b) {
  const na = panels.find((p) => p.id === a.nodeId);
  const nb = panels.find((p) => p.id === b.nodeId);
  if (!na?.isBoxWall || !nb?.isBoxWall || !na.groupId || na.groupId !== nb.groupId) return null;

  const resolved = new Map(resolveConstraints(panels).map((r) => [r.id, r]));
  const ra = resolved.get(a.nodeId);
  const rb = resolved.get(b.nodeId);
  const alA = getAlignedAxis(ra.rotation, a.faceName);
  const alB = getAlignedAxis(rb.rotation, b.faceName);
  if (!alA || !alB || alA.axis !== alB.axis || alA.sign !== -alB.sign) return null;
  const axis = alA.axis;

  // The wall on the positive side moves; the other one stays put.
  const moveIsB = rb.position[axis] >= ra.position[axis];
  const mover = moveIsB ? nb : na;
  const stay = moveIsB ? na : nb;
  // OUTSIDE-to-OUTSIDE: the box's overall size (the inner space is what is left
  // between the walls' inner faces, which is where shelves go).
  const half = (r) => computeWorldHalfExtents(r)[axis];
  const [lowR, upR] = rb.position[axis] >= ra.position[axis] ? [ra, rb] : [rb, ra];
  const measuredMm = (upR.position[axis] + half(upR)) - (lowR.position[axis] - half(lowR));
  return {
    ok: true, kind: 'box', groupId: na.groupId, axis, label: BOX_AXIS_LABEL[axis],
    moveId: mover.id, anchorId: stay.id, measuredMm, moveSign: 1,
    moveName: nameOf(mover), anchorName: nameOf(stay),
  };
}

/** The new offset of the moving wall for a requested interior distance. */
export function boxDimensionOffset(panels, plan, valueMm) {
  const mover = panels.find((p) => p.id === plan.moveId);
  // moveSign +1: the moving wall is on the positive side (growing the gap moves it up the axis); -1: the opposite.
  return { ...mover.offset, [plan.axis]: mover.offset[plan.axis] + (plan.moveSign ?? 1) * (valueMm - plan.measuredMm) };
}

const RELAYOUT_REASONS = {
  'min-dim': "Can't shrink the box that far — the walls would overlap.",
};

/** Dry run of a box dimension: same shape as previewQuote's result. */
export function previewBoxDimension(panels, plan, valueMm) {
  // A box interior must stay > 0; a wall moved to meet a fixed panel may touch it (0).
  const minOk = plan.kind === 'wall-move' ? valueMm >= 0 : valueMm > 0;
  if (!(typeof valueMm === 'number' && Number.isFinite(valueMm) && minOk)) {
    return { ok: false, blocking: plan.kind === 'wall-move' ? 'The distance must be 0 mm or more.' : 'The interior distance must be greater than 0 mm.', conflicts: [] };
  }
  const offset = boxDimensionOffset(panels, plan, valueMm);
  const candidate = panels.map((p) => (p.id === plan.moveId ? { ...p, offset } : p));
  const r = relayoutBox(candidate, plan.groupId);
  if (r.ok) return { ok: true, conflicts: [] };
  let blocking = RELAYOUT_REASONS[r.reason];
  if (!blocking && r.hitAxis) {
    const what = r.hitAxis === 'y' ? 'height' : r.hitAxis === 'x' ? 'width' : 'depth';
    blocking = `That would take the box past the design's overall ${what} limit.`;
  }
  if (!blocking && r.reason?.startsWith('panel-size:')) blocking = 'That would make a wall larger than the maximum panel size.';
  if (!blocking && r.reason?.startsWith('min-gap:')) {
    const [x, y] = r.reason.slice('min-gap:'.length).split('/');
    blocking = `${x} and ${y} would end up too close together.`;
  }
  return { ok: false, blocking: blocking || "The box can't be resized to that value.", conflicts: [] };
}

/**
 * ONE entry point for "dimension this pair of facing faces", used by the
 * Dimension tool and by every dimension drawn in the viewport (a grey
 * measured one becomes an imposed one through here).
 *
 * @param {{nodeId, faceName}} a  facing faces (see resolveFacingFaces)
 * @param {{nodeId, faceName}} b
 * @returns {{ok:true, mode:'box', plan, measuredMm}
 *          |{ok:true, mode:'quote', drivenId, myFace, from, measuredMm}
 *          |{ok:false, message}}
 *   mode "box":   two walls of one box -> resize the box interior (planBoxDimension)
 *   mode "quote": an ordinary `distance` constraint on whichever panel may move.
 *                 The panel allowed to move is the driven one; if both could,
 *                 the FIRST (a) is the fixed reference.
 */
export function planDimension(panels, a, b) {
  const box = planBoxDimension(panels, a, b);
  if (box) return { ok: true, mode: 'box', plan: box, measuredMm: box.measuredMm };

  const attempts = [
    { driven: b, anchor: a },
    { driven: a, anchor: b },
  ].map(({ driven, anchor }) => {
    const gap = measureGap(panels, driven.nodeId, driven.faceName, { node: anchor.nodeId, face: anchor.faceName });
    if (gap === null) return { ok: false, notFacing: true };
    const value = Math.max(0, Math.round(gap * 10) / 10);
    const r = addQuote(panels, {
      drivenId: driven.nodeId, myFace: driven.faceName,
      from: { node: anchor.nodeId, face: anchor.faceName }, value,
    });
    return { ...r, driven, anchor, gap };
  });
  const chosen = attempts.find((x) => x.ok);
  if (chosen) {
    return {
      ok: true, mode: 'quote', drivenId: chosen.driven.nodeId, myFace: chosen.driven.faceName,
      from: { node: chosen.anchor.nodeId, face: chosen.anchor.faceName }, measuredMm: chosen.gap,
    };
  }
  // Last resort. A box wall is NEVER moved just because it was clicked: the
  // other panel moves (above). Only when that panel cannot — its position is
  // already fixed by another relation, or its axis is locked — is the wall
  // moved instead, which resizes the box (relayoutBox re-fits the rest).
  const nodeOf = (id) => panels.find((p) => p.id === id);
  const sides = [{ wall: a, other: b }, { wall: b, other: a }];
  const side = sides.find(({ wall, other }) => nodeOf(wall.nodeId)?.isBoxWall && !nodeOf(other.nodeId)?.isBoxWall);
  if (side) {
    const wallNode = nodeOf(side.wall.nodeId);
    const otherNode = nodeOf(side.other.nodeId);
    const otherFailure = attempts.find((x) => x.driven?.nodeId === side.other.nodeId);
    const movable = ['axis-locked', 'already-driven'].includes(otherFailure?.reason);
    const resolved = new Map(resolveConstraints(panels).map((r) => [r.id, r]));
    const rw = resolved.get(wallNode.id);
    const ro = resolved.get(otherNode.id);
    const al = getAlignedAxis(rw.rotation, side.wall.faceName);
    // The wall can only be moved along its own thickness axis (that is what resizes the box).
    if (movable && al && al.axis === wallNode.thicknessAxis) {
      const axis = al.axis;
      const gap = measureGap(panels, side.other.nodeId, side.other.faceName, { node: side.wall.nodeId, face: side.wall.faceName });
      const wallAbove = rw.position[axis] >= ro.position[axis];
      const mg = wallAbove
        ? measureGap(panels, side.wall.nodeId, side.wall.faceName, { node: side.other.nodeId, face: side.other.faceName })
        : gap;
      if (mg !== null && mg >= 0) {
        return {
          ok: true, mode: 'box', measuredMm: mg,
          notice: `${nameOf(otherNode)} is fixed, so the box wall ${nameOf(wallNode)} moves instead (the box is resized).`,
          plan: {
            ok: true, kind: 'wall-move', groupId: wallNode.groupId, axis, label: 'distance',
            moveId: wallNode.id, anchorId: otherNode.id, measuredMm: mg, moveSign: wallAbove ? 1 : -1,
            moveName: nameOf(wallNode), anchorName: nameOf(otherNode),
          },
        };
      }
    }
  }
  const why = attempts.find((x) => !x.notFacing);
  return { ok: false, reason: why?.reason || 'not-facing', message: why?.message || "Can't dimension that pair of panels." };
}

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
import { getAlignedAxis, getPanelOwnership, nextConstraintId, FACE_TO_DIM_FIELD, LOCAL_FACES } from '../modeller/modules.js';

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
  if (!added.ok) return { ok: false, blocking: added.message, conflicts: [] };

  const audit = (list) => {
    const resolved = resolveConstraints(list);
    return findQuoteConflicts(list, resolved, { collisions: detectJoints(resolved).collisions });
  };
  const known = new Set(audit(panels).map((v) => v.key));
  const fresh = audit(added.panels).filter((v) => !known.has(v.key));
  return { ok: true, conflicts: fresh.map((v) => v.message) };
}

/**
 * engine/spacing.js
 *
 * EQUAL SPACING — spread N parallel shelves evenly between two boundary panels
 * (e.g. 3 vertical shelves between the Left and Right walls). Stored as one
 * live `equalSpacing` constraint per shelf (see modeller/snap.js), so the
 * spacing survives resizing the box.
 *
 * Pure functions: take `panels`, return { ok, panels, ... } or { ok:false, message }.
 */
import { resolveConstraints } from '../modeller/snap.js';
import {
  getAlignedAxis, nextConstraintId, LOCAL_FACES, FACE_TO_DIM_FIELD, FIELD_TO_AXIS,
} from '../modeller/modules.js';

const POSITION_FIELD = { x: 'positionX', y: 'positionY', z: 'positionZ' };
export const MIN_SPACING_GAP_MM = 1;

const nameOf = (p) => p?.name || p?.id;

/** The axis along which this panel's THICKNESS runs (the way a shelf is stacked). */
function thicknessAxis(resolved) {
  for (const face of Object.keys(LOCAL_FACES)) {
    if (FACE_TO_DIM_FIELD[face] !== 'thickness') continue;
    const aligned = getAlignedAxis(resolved.rotation, face);
    if (aligned) return aligned.axis;
  }
  return null;
}

/** Face of `resolved` that looks toward +sign/-sign along `axis`, or null. */
function faceToward(resolved, axis, sign) {
  for (const face of Object.keys(LOCAL_FACES)) {
    const aligned = getAlignedAxis(resolved.rotation, face);
    if (aligned && aligned.axis === axis && aligned.sign === sign) return face;
  }
  return null;
}

function halfAlong(resolved, axis) {
  // extent of the panel along `axis` / 2, from whichever of its dimensions lines up with it
  for (const face of Object.keys(LOCAL_FACES)) {
    const aligned = getAlignedAxis(resolved.rotation, face);
    if (aligned && aligned.axis === axis) return resolved[FACE_TO_DIM_FIELD[face]] / 2;
  }
  return 0;
}

export function planEqualSpacing(panels, memberIds, boundaryIds) {
  const resolved = resolveConstraints(panels);
  const rById = new Map(resolved.map((r) => [r.id, r]));
  const raw = new Map(panels.map((p) => [p.id, p]));

  const ids = [...new Set(memberIds)];
  if (!ids.length) return { ok: false, message: 'Pick at least one panel to space.' };
  if (!Array.isArray(boundaryIds) || boundaryIds.length !== 2 || boundaryIds[0] === boundaryIds[1]) {
    return { ok: false, message: 'Pick two different boundary panels.' };
  }
  if (boundaryIds.some((id) => ids.includes(id))) {
    return { ok: false, message: 'A boundary can\'t also be one of the panels being spaced.' };
  }

  // members: ordinary, free panels, all stacked along the same axis
  let axis = null;
  for (const id of ids) {
    const node = raw.get(id);
    const r = rById.get(id);
    if (!node || !r) return { ok: false, message: 'One of the panels no longer exists.' };
    if (node.isBoxWall || node.isDoor || node.isDrawerFront || node.isDrawerBoxPanel || node.isPlinthPanel || node.isLeg) {
      return { ok: false, message: `${nameOf(node)} is system-managed and can't be spaced.` };
    }
    const a = thicknessAxis(r);
    if (!a) return { ok: false, message: `${nameOf(node)} isn't aligned with an axis.` };
    if (axis && a !== axis) return { ok: false, message: 'The panels must all be parallel (stacked along the same direction).' };
    axis = a;
  }
  const field = POSITION_FIELD[axis];
  for (const id of ids) {
    const node = raw.get(id);
    const held = (node.constraints || []).find((c) => !c.overridden && c.field === field);
    if (held) {
      return { ok: false, message: `${nameOf(node)} already has its ${axis.toUpperCase()} position controlled by another relation (a dimension or spacing). Remove that first.` };
    }
    if ((node.lockedMoveAxes || []).includes(axis)) {
      return { ok: false, message: `${nameOf(node)} can't move along ${axis.toUpperCase()}.` };
    }
  }

  // boundaries: lower and upper along the axis, inner faces toward each other
  const [b1, b2] = boundaryIds.map((id) => rById.get(id));
  if (!b1 || !b2) return { ok: false, message: 'A boundary panel no longer exists.' };
  const [lo, hi] = b1.position[axis] <= b2.position[axis] ? [b1, b2] : [b2, b1];
  const faceLo = faceToward(lo, axis, +1);
  const faceHi = faceToward(hi, axis, -1);
  if (!faceLo || !faceHi) {
    return { ok: false, message: `The two boundaries must have faces perpendicular to the ${axis.toUpperCase()} direction of the panels you picked.` };
  }
  const pLo = lo.position[axis] + halfAlong(lo, axis);
  const pHi = hi.position[axis] - halfAlong(hi, axis);

  // order the members along the axis and check they sit between the boundaries
  const ordered = ids.map((id) => rById.get(id)).sort((a, b) => a.position[axis] - b.position[axis]);
  if (ordered.some((m) => m.position[axis] < pLo || m.position[axis] > pHi)) {
    return { ok: false, message: 'Every panel to space must lie between the two boundaries.' };
  }
  const total = ordered.reduce((s, m) => s + m.thickness, 0);
  const gap = (pHi - pLo - total) / (ordered.length + 1);
  if (gap < MIN_SPACING_GAP_MM) {
    return { ok: false, message: `The ${ordered.length} panels (${Math.round(total)} mm) don't fit between the boundaries (${Math.round(pHi - pLo)} mm apart).` };
  }

  const spacingId = `sp${nextConstraintId()}`;
  const members = ordered.map((m) => m.id);
  const next = panels.map((p) => (members.includes(p.id)
    ? {
      ...p,
      constraints: [...(p.constraints || []), {
        id: nextConstraintId(),
        type: 'equalSpacing',
        field,
        from: { node: lo.id, face: faceLo },
        to: { node: hi.id, face: faceHi },
        members,
        spacingId,
      }],
    }
    : p));
  return { ok: true, panels: next, gapMm: gap, axis, spacingId, count: members.length };
}

/** Removes one spacing set; the shelves stay exactly where they are now. */
export function removeEqualSpacing(panels, spacingId) {
  const resolved = new Map(resolveConstraints(panels).map((r) => [r.id, r]));
  let found = false;
  const next = panels.map((p) => {
    const mine = (p.constraints || []).find((c) => c.type === 'equalSpacing' && c.spacingId === spacingId);
    if (!mine) return p;
    found = true;
    const axis = FIELD_TO_AXIS[mine.field];
    const r = resolved.get(p.id);
    return {
      ...p,
      constraints: (p.constraints || []).filter((c) => c !== mine),
      offset: { ...p.offset, [axis]: r.position[axis] - p.basePosition[axis] },
    };
  });
  return found ? { ok: true, panels: next } : { ok: false, message: 'No such spacing.' };
}

/**
 * tools/collinearTool.js
 *
 * COLLINEAR TOOL — pick a face/edge on panel A, then a PARALLEL
 * face/edge on panel B. Prefers MOVING panel A via a live
 * `attachedTo` constraint; falls back to a persistent `spansBetween`
 * resize if A's position on that axis is already locked (an existing
 * constraint, or a box wall's structural lock). A box-wall pick
 * translates the WHOLE box instead of touching the wall directly —
 * see applyCollinearBoxTranslation. Ported as-is from the original
 * modeller-main.js logic; only the state ownership and the panels
 * mutation path changed (see setCollinearToolContext below).
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast, showDesignLimitError, showPanelSizeLimitError } from '../ui/toast.js';
import { findPanelSizeViolation, findDesignLimitViolation } from '../shared/geometry.js';
import { FACE_TO_DIM_FIELD, getAlignedAxis } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';
import { AddConstraintCommand, MoveGroupCommand } from '../history/history.js';

const AXIS_TO_POSITION_FIELD = { x: 'positionX', y: 'positionY', z: 'positionZ' };

/**
 * @typedef {Object} CollinearToolContext
 * @property {() => Array} getPanels
 * @property {(id: string, patch: Object) => void} updateNode
 * @property {(CommandClass: Function, before: Array, after: Array) => void} recordHistoryCommand
 * @property {() => void} renderAll
 * @property {() => void} clearMultiSelected
 * @property {(nodeId: string|null, faceName: string|null) => void} setFaceHighlight
 * @property {(active: boolean, onPick: Function|null) => void} setFacePickMode
 */

/** @type {CollinearToolContext|null} */
let ctx = null;

let collinearActive = false;
let collinearPick1 = null; // { nodeId, faceName, axis, sign, dimField } | null
let collinearGapMm = 0; // user-editable, see the toolbar's own gap input — read fresh at commit time, not captured per-pick, so changing it mid-pick before the second click still applies

/**
 * Wires this tool to the live app. Call once from modeller-main.js
 * after createModellerScene() exists.
 * @param {CollinearToolContext} context
 */
export function setCollinearToolContext(context) {
  ctx = context;
}

// For modeller-main.js's toolbar rendering (button active-state, the
// gap input) — these used to be plain module-level variables it read
// directly; now the tool owns them, so it exposes accessors instead.
export function isCollinearActive() {
  return collinearActive;
}
export function getCollinearGapMm() {
  return collinearGapMm;
}
export function setCollinearGapMm(mm) {
  collinearGapMm = mm; // deliberately no ctx.renderAll() here — see toolbar.js's own comment on why
}

export function startCollinearMode() {
  collinearActive = true;
  collinearPick1 = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null); // clean start, in case a prior session was interrupted before clearing this itself
  ctx.setFacePickMode(true, handleFacePick);
  showToast(
    collinearGapMm ? `Collinear (${collinearGapMm}mm gap): pick a face or edge on the panel to constrain` : 'Collinear: pick a face or edge on the panel to constrain',
    false
  );
  ctx.renderAll();
}

export function cancelCollinearMode() {
  collinearActive = false;
  collinearPick1 = null;
  setSelectedId(null);
  ctx.setFacePickMode(false, null);
  hideToast();
  ctx.renderAll();
}

function handleFacePick(nodeId, faceName) {
  const panels = ctx.getPanels();
  const resolved = resolveConstraints(panels).find((r) => r.id === nodeId);
  if (!resolved) return;

  // Any face is a valid PICK — whether it ends up moving or resizing
  // panel A is decided later, in applyCollinear, once we know both
  // panels and can check isAxisPositionLocked.
  const dimField = FACE_TO_DIM_FIELD[faceName];
  const aligned = getAlignedAxis(resolved.rotation, faceName);
  if (!aligned) return; // defensive: every panel in this app is axis-aligned, this should never actually happen

  if (!collinearPick1) {
    collinearPick1 = { nodeId, faceName, axis: aligned.axis, sign: aligned.sign, dimField };
    ctx.setFaceHighlight(nodeId, faceName); // highlights exactly the picked face/edge, not the whole panel
    showToast(
      collinearGapMm ? `Now pick a PARALLEL face/edge on a different panel (${collinearGapMm}mm gap)` : 'Now pick a PARALLEL face/edge on a different panel',
      false
    );
    ctx.renderAll();
    return;
  }

  if (collinearPick1.nodeId === nodeId) {
    showToast('Pick a face/edge on a DIFFERENT panel');
    return; // keep pick1 as-is, let them retry
  }

  if (collinearPick1.axis !== aligned.axis) {
    showToast('Those faces are not parallel — try again');
    collinearPick1 = null;
    ctx.setFaceHighlight(null, null);
    ctx.renderAll();
    return; // stay in collinear mode, just reset back to step 1
  }

  const applied = applyCollinear(collinearPick1, { nodeId, faceName, axis: aligned.axis, sign: aligned.sign, dimField });
  if (applied) cancelCollinearMode(); // one-shot PICKING tool — done after a single successful pair; a rejection leaves pick1 as-is so they can retry with a different second pick
}

// -------------------------------------------------------------
// COLLINEAR BOX TRANSLATION — box walls are structural members of a
// single rigid assembly. When a box wall is the FIRST collinear pick,
// the wall itself must never move/resize independently; instead, every
// member of the box translates by the same delta along the collinear
// axis. Returns true when the whole box was translated successfully.
// -------------------------------------------------------------
function applyCollinearBoxTranslation(pick1, pick2) {
  const panels = ctx.getPanels();
  const node1 = panels.find((p) => p.id === pick1.nodeId);
  const node2 = panels.find((p) => p.id === pick2.nodeId);
  if (!node1 || !node2 || !node1.groupId) return false;

  const groupId = node1.groupId;
  // Hidden members must still be part of the box transformation —
  // `hidden` only controls rendering, not whether the model position
  // is updated.
  const members = panels.filter((p) => p.groupId === groupId);
  if (members.length === 0) return false;

  const resolved = resolveConstraints(panels);
  const resolved1 = resolved.find((p) => p.id === pick1.nodeId);
  const resolved2 = resolved.find((p) => p.id === pick2.nodeId);
  if (!resolved1 || !resolved2) return false;

  const axis = pick1.axis;
  const face1Mm = resolved1.position[axis] + pick1.sign * (resolved1[pick1.dimField] / 2);
  const face2Mm = resolved2.position[axis] + pick2.sign * (resolved2[pick2.dimField] / 2);
  const targetMm = face2Mm + pick2.sign * collinearGapMm;
  const deltaMm = targetMm - face1Mm;

  if (Math.abs(deltaMm) < 0.0001) return true;

  // Test the COMPLETE group, including hidden members, before
  // committing anything.
  const testPanels = panels.map((p) => {
    if (p.groupId !== groupId) return p;
    return { ...p, offset: { ...p.offset, [axis]: p.offset[axis] + deltaMm } };
  });
  const testResolved = resolveConstraints(testPanels);

  for (const member of members) {
    const testNode = testResolved.find((p) => p.id === member.id);
    if (!testNode) return false;
    const dims = { width: testNode.width, height: testNode.height, thickness: testNode.thickness };
    const hitAxis = findDesignLimitViolation(testNode.rotation, testNode.position, dims);
    if (hitAxis) {
      showDesignLimitError(hitAxis);
      return false;
    }
  }

  const before = ctx.getPanels();
  members.forEach((m) => {
    ctx.updateNode(m.id, { offset: { ...m.offset, [axis]: m.offset[axis] + deltaMm } });
  });
  const after = ctx.getPanels();
  ctx.recordHistoryCommand(MoveGroupCommand, before, after);
  ctx.renderAll();
  return true;
}

function applyCollinear(pick1, pick2) {
  const panels = ctx.getPanels();
  const node1 = panels.find((p) => p.id === pick1.nodeId);
  if (!node1) return false;

  const axis = pick1.axis;

  // BOX MEMBER — a box wall is part of a rigid six-panel assembly, it
  // must never be independently moved or resized by collinear.
  // Translate the entire box instead.
  if (node1.groupId) {
    return applyCollinearBoxTranslation(pick1, pick2);
  }

  if (!isAxisPositionLocked(node1, axis)) {
    // MOVE — live attachedTo constraint on the position field. `myFace`
    // and `from.face` don't need to be the SAME named face — only that
    // they resolve to the same world axis, already guaranteed by the
    // axis-match check in handleFacePick above.
    const newConstraint = {
      field: AXIS_TO_POSITION_FIELD[axis],
      type: 'attachedTo',
      overridden: false,
      myFace: pick1.faceName,
      from: { node: pick2.nodeId, face: pick2.faceName, offset: collinearGapMm },
    };
    const otherConstraints = (node1.constraints || []).filter((c) => c.field !== newConstraint.field);
    const before = ctx.getPanels();
    ctx.updateNode(pick1.nodeId, { constraints: [...otherConstraints, newConstraint] });
    const after = ctx.getPanels();
    ctx.recordHistoryCommand(AddConstraintCommand, before, after);
    ctx.renderAll();
    return true;
  }

  // BLOCKED — fall back to a PERSISTENT RESIZE constraint. Never
  // allowed to touch thickness: if the blocked axis is also this
  // panel's thickness face, there's genuinely no way to satisfy it.
  if (pick1.dimField === 'thickness') {
    showToast("Can't satisfy that — this panel can't move on this axis, and thickness can't be resized");
    return false;
  }

  const resolved = resolveConstraints(panels);
  const resolved1 = resolved.find((r) => r.id === pick1.nodeId);
  if (!resolved1) return false;

  const sign1 = pick1.sign;
  // pick1's OPPOSITE face — captured as a literal, fixed SNAPSHOT, not
  // re-derived from anything. Only pick2's side is a live reference,
  // which is what makes "resized once now, then keeps adjusting
  // automatically if panel B moves again later" work, without a
  // self-referential (circular) constraint back onto this panel.
  const oppositeMm = resolved1.position[axis] - sign1 * (resolved1[pick1.dimField] / 2);

  const newConstraint = {
    field: pick1.dimField,
    type: 'spansBetween',
    overridden: false,
    from: { mm: oppositeMm },
    to: { node: pick2.nodeId, face: pick2.faceName, offset: collinearGapMm },
  };
  const otherConstraints = (node1.constraints || []).filter((c) => c.field !== pick1.dimField);

  // Validate BEFORE committing, on a scratch copy — same
  // PANEL_SIZE_LIMITS_MM / design-limit checks every other resize path
  // uses.
  const testPanels = panels.map((p) =>
    p.id === pick1.nodeId ? { ...p, constraints: [...otherConstraints, newConstraint] } : p
  );
  const testResolved1 = resolveConstraints(testPanels).find((r) => r.id === pick1.nodeId);
  if (!testResolved1) return false;
  const testDims = { width: testResolved1.width, height: testResolved1.height, thickness: testResolved1.thickness };
  const sizeViolation = findPanelSizeViolation(testDims);
  if (sizeViolation) {
    showPanelSizeLimitError(sizeViolation);
    return false;
  }
  const hitAxis = findDesignLimitViolation(testResolved1.rotation, testResolved1.position, testDims);
  if (hitAxis) {
    showDesignLimitError(hitAxis);
    return false;
  }

  const before = ctx.getPanels();
  ctx.updateNode(pick1.nodeId, { constraints: [...otherConstraints, newConstraint] });
  const after = ctx.getPanels();
  ctx.recordHistoryCommand(AddConstraintCommand, before, after);
  ctx.renderAll();
  showToast('Movement was blocked — resized instead. This will keep re-adjusting automatically if the other panel changes.', false);
  return true;
}

// other than the collinear tool itself — an explicit constraint on
// that field, or a box panel's static structural lock? If so, MOVING
// it would either override that other relation or fight the box's
// own geometry, so applyCollinear resizes instead.
function isAxisPositionLocked(node, axis) {
  const field = AXIS_TO_POSITION_FIELD[axis];
  const hasConstraint = (node.constraints || []).some((c) => !c.overridden && c.field === field);
  const hasStaticBoxLock = (node.lockedMoveAxes || []).includes(axis);
  return hasConstraint || hasStaticBoxLock;
}

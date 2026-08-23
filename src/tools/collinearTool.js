// -------------------------------------------------------------
// COLLINEAR TOOL — pick a face/edge on panel A, then a PARALLEL
// face/edge on panel B.
//
// Prefers MOVING panel A: adds an ordinary `attachedTo` constraint on
// whichever positionX/Y/Z field the shared axis corresponds to (the
// same constraint type/math the box preset's own top/bottom already
// use internally, see snap.js's applyAttachedTo) — live and
// persistent, so if panel B is later moved or resized, panel A's
// picked face keeps re-resolving to stay collinear with it.
//
// But if panel A's position on that axis is already spoken for —
// either an existing constraint on that field (e.g. a previous
// collinear link), or a box panel's own structural lockedMoveAxes
// (e.g. Top/Bottom's X/Z, Left/Right's Y/Z — see addBox) — moving it
// would either silently override something else or fight the box's
// own geometry, so it falls back to a PERSISTENT RESIZE constraint
// instead: a `spansBetween` on panel A's dimension field, anchored
// between a captured SNAPSHOT of its opposite face's position (a
// literal `{ mm }` endpoint — see snap.js's resolveFacePointMm) and a
// live reference to panel B's picked face. The snapshot side never
// moves again, but because the OTHER side is live, panel A's picked
// face keeps re-resolving to stay collinear whenever panel B moves or
// resizes later — the same "adjusts automatically" guarantee as the
// move case above, just via a dimension instead of a position. What
// it does NOT track: if the SNAPSHOT side's own anchor later moves
// too (e.g. because the box's Left/Right get resized after the fact),
// that motion isn't followed — only continued changes to panel B are.
// This fallback can NEVER apply to a thickness face — if the blocked
// axis is also this panel's thickness, there is no way to satisfy the
// request at all (moving is blocked, and thickness can't be resized),
// and the pick is rejected outright.
//
// (A live constraint for the MOVE case works because it references
// panel B, an already-resolved OTHER node. The resize-fallback's
// snapshot anchor exists because the alternative — a live reference
// back to panel A's own not-yet-resolved current position — is a
// self-referential dependency; topoSort above would just flag it
// circular. The snapshot sidesteps that by not depending on ANY
// node's resolution at all.)
// -------------------------------------------------------------

import {FACE_TO_DIM_FIELD, getAlignedAxis} from '../modeller/modules.js'
import {resolveConstraints} from '../modeller/snap.js'
import {setSelectedId, setSelectedGroupId} from '../modeller/selection.js'
import {findPanelSizeViolation, findDesignLimitViolation} from '../shared/geometry.js'
import {showToast, showDesignLimitError, showPanelSizeLimitError} from '../ui/toast.js'

// setFacePickMode, setFaceHighlight :
// these come back from createModellerScene(...)'s return value
// inside modeller-main.js. This tool needs them passed in (an
// init(sceneHandles) call, or each function taking them as a parameter)
// rather than importing them, since they're created at runtime,
// not module-level exports.

const AXIS_TO_POSITION_FIELD = { x: 'positionX', y: 'positionY', z: 'positionZ' };


export function startCollinearMode() {
  if (shelfMode) cancelShelfMode(); // mutually exclusive — both are single-slot pick-mode tools sharing setFacePickMode
  collinearActive = true;
  collinearPick1 = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  multiSelectedIds.clear();
  setFaceHighlight(null, null); // clean start, in case a prior session was interrupted before clearing this itself
  setFacePickMode(true, handleFacePick);
  showToast(
    collinearGapMm ? `Collinear (${collinearGapMm}mm gap): pick a face or edge on the panel to constrain` : 'Collinear: pick a face or edge on the panel to constrain',
    false
  );
  renderAll();
}

export function cancelCollinearMode() {
  collinearActive = false;
  collinearPick1 = null;
  setSelectedId(null);
  setFacePickMode(false, null);
  hideToast();
  renderAll();
}

function handleFacePick(nodeId, faceName) {
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
    setFaceHighlight(nodeId, faceName); // highlights exactly the picked face/edge, not the whole panel — see scene.js's setFaceHighlight
    showToast(
      collinearGapMm ? `Now pick a PARALLEL face/edge on a different panel (${collinearGapMm}mm gap)` : 'Now pick a PARALLEL face/edge on a different panel',
      false
    );
    renderAll();
    return;
  }

  if (collinearPick1.nodeId === nodeId) {
    showToast('Pick a face/edge on a DIFFERENT panel');
    return; // keep pick1 as-is, let them retry
  }

  if (collinearPick1.axis !== aligned.axis) {
    showToast('Those faces are not parallel — try again');
    collinearPick1 = null;
    setFaceHighlight(null, null);
    renderAll();
    return; // stay in collinear mode, just reset back to step 1
  }

  const applied = applyCollinear(collinearPick1, { nodeId, faceName, axis: aligned.axis, sign: aligned.sign, dimField });
  if (applied) cancelCollinearMode(); // one-shot PICKING tool — done after a single successful pair; a rejection (see applyCollinear) leaves pick1 as-is so they can retry with a different second pick
}

// -------------------------------------------------------------
// COLLINEAR BOX TRANSLATION
//
// Box walls are structural members of a single rigid assembly.
// When a box wall is the FIRST collinear pick, the wall itself must
// never move/resize independently. Instead, translate every member
// of the box by the same delta along the collinear axis.
//
// The target is calculated from the currently resolved position of
// pick1's selected face and pick2's selected face. The gap value is
// applied in the same direction as the existing attachedTo logic.
//
// Returns true when the whole box was translated successfully.
// -------------------------------------------------------------
function applyCollinearBoxTranslation(pick1, pick2) {
  const node1 = panels.find((p) => p.id === pick1.nodeId);
  const node2 = panels.find((p) => p.id === pick2.nodeId);

  if (!node1 || !node2 || !node1.groupId) return false;

  const groupId = node1.groupId;

  // IMPORTANT:
  // Hidden members must still be part of the box transformation.
  // `hidden` should only control rendering, not whether the model
  // position is updated.
  const members = panels.filter(
    (p) => p.groupId === groupId
  );

  if (members.length === 0) return false;

  const resolved = resolveConstraints(panels);
  const resolved1 = resolved.find((p) => p.id === pick1.nodeId);
  const resolved2 = resolved.find((p) => p.id === pick2.nodeId);

  if (!resolved1 || !resolved2) return false;

  const axis = pick1.axis;

  const face1Mm =
    resolved1.position[axis] +
    pick1.sign * (resolved1[pick1.dimField] / 2);

  const face2Mm =
    resolved2.position[axis] +
    pick2.sign * (resolved2[pick2.dimField] / 2);

  const targetMm =
    face2Mm + pick2.sign * collinearGapMm;

  const deltaMm = targetMm - face1Mm;

  if (Math.abs(deltaMm) < 0.0001) {
    return true;
  }

  // Test the COMPLETE group, including hidden members.
  const testPanels = panels.map((p) => {
    if (p.groupId !== groupId) return p;

    return {
      ...p,
      offset: {
        ...p.offset,
        [axis]: p.offset[axis] + deltaMm,
      },
    };
  });

  const testResolved = resolveConstraints(testPanels);

  for (const member of members) {
    const testNode = testResolved.find((p) => p.id === member.id);
    if (!testNode) return false;

    const dims = {
      width: testNode.width,
      height: testNode.height,
      thickness: testNode.thickness,
    };

    const hitAxis = findDesignLimitViolation(
      testNode.rotation,
      testNode.position,
      dims
    );

    if (hitAxis) {
      showDesignLimitError(hitAxis);
      return false;
    }
  }

  const before = panels;

  // IMPORTANT:
  // Apply the translation to ALL group members, hidden or visible.
  panels = panels.map((p) => {
    if (p.groupId !== groupId) return p;

    return {
      ...p,
      offset: {
        ...p.offset,
        [axis]: p.offset[axis] + deltaMm,
      },
    };
  });

  const after = panels;

  recordHistoryCommand(MoveGroupCommand, before, after);

  renderAll();

  return true;
}

function applyCollinear(pick1, pick2) {
  const node1 = panels.find((p) => p.id === pick1.nodeId);
  if (!node1) return false;

  const axis = pick1.axis;

  // -----------------------------------------------------------
  // BOX MEMBER
  //
  // A box wall is part of a rigid six-panel assembly. It must
  // never be independently moved or resized by collinear.
  // Translate the entire box instead.
  // -----------------------------------------------------------
  if (node1.groupId) {
    return applyCollinearBoxTranslation(pick1, pick2);
  }

  if (!isAxisPositionLocked(node1, axis)) {
    // MOVE — live attachedTo constraint on the position field. `myFace`
    // and `from.face` don't need to be the SAME named face (e.g. panel
    // A's "right" face can be made collinear with panel B's "left"
    // face) — only that they resolve to the same world axis, already
    // guaranteed by the axis-match check in handleFacePick above.
    const newConstraint = {
      field: AXIS_TO_POSITION_FIELD[axis],
      type: 'attachedTo',
      overridden: false,
      myFace: pick1.faceName,
      from: { node: pick2.nodeId, face: pick2.faceName, offset: collinearGapMm },
    };
    // A field can only be governed by one constraint at a time — if
    // this panel already had some other constraint on this exact
    // field, replace it rather than stacking a second, conflicting
    // one (isAxisPositionLocked above already ruled out that case
    // here, so in practice this filter is a no-op today, but it keeps
    // this function correct if that check's rules ever change).
    const otherConstraints = (node1.constraints || []).filter((c) => c.field !== newConstraint.field);
    const before = panels;
    updateNode(pick1.nodeId, { constraints: [...otherConstraints, newConstraint] });
    const after = panels;
    recordHistoryCommand(AddConstraintCommand,before,after); // resolveConstraints picks up the new constraint immediately — if it happens to create a dependency cycle, the resolver already handles that gracefully (a warning on the affected node, not a crash) rather than needing special-cased detection here
    renderAll();
    return true;
  }

  // BLOCKED — fall back to a PERSISTENT RESIZE constraint. Never
  // allowed to touch thickness: if the blocked axis is also this
  // panel's thickness face, there's genuinely no way to satisfy the
  // request.
  if (pick1.dimField === 'thickness') {
    showToast("Can't satisfy that — this panel can't move on this axis, and thickness can't be resized");
    return false;
  }

  const resolved = resolveConstraints(panels);
  const resolved1 = resolved.find((r) => r.id === pick1.nodeId);
  if (!resolved1) return false;

  const sign1 = pick1.sign;
  // pick1's OPPOSITE face — captured as a literal, fixed SNAPSHOT (see
  // the `{ mm }` literal-endpoint support added to snap.js's
  // resolveFacePointMm specifically for this), not re-derived from
  // anything. Only pick2's side of the constraint below is a live
  // reference — which is exactly what makes "resized once now, then
  // keeps adjusting automatically if panel B moves again later" work,
  // without needing a self-referential (and therefore circular)
  // constraint back onto this panel's own current position.
  const oppositeMm = resolved1.position[axis] - sign1 * (resolved1[pick1.dimField] / 2);

  const newConstraint = {
    field: pick1.dimField,
    type: 'spansBetween',
    overridden: false,
    from: { mm: oppositeMm },
    to: { node: pick2.nodeId, face: pick2.faceName, offset: collinearGapMm },
  };
  // A field can only be governed by one constraint at a time — replace
  // any existing one on this exact dimension field rather than
  // stacking a second, conflicting one.
  const otherConstraints = (node1.constraints || []).filter((c) => c.field !== pick1.dimField);

  // Validate BEFORE committing — same PANEL_SIZE_LIMITS_MM / scene
  // bounds checks every other resize path uses — by test-resolving a
  // scratch copy of `panels` with the constraint already applied,
  // since a constraint-derived dimension doesn't go through
  // applyDimensionChange the way a literal offset/dims edit does.
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

  const before = panels;
  updateNode(pick1.nodeId, { constraints: [...otherConstraints, newConstraint] });
  const after = panels;
  recordHistoryCommand(AddConstraintCommand,before,after);
  renderAll();
  showToast('Movement was blocked — resized instead. This will keep re-adjusting automatically if the other panel changes.', false);
  return true;
}

// other than the collinear tool itself — an explicit constraint on
// that field, or a box panel's static structural lock? If so, MOVING
// it would either override that other relation or fight the box's
// own geometry, so applyCollinear should resize instead.
function isAxisPositionLocked(node, axis) {
  const field = AXIS_TO_POSITION_FIELD[axis];
  const hasConstraint = (node.constraints || []).some((c) => !c.overridden && c.field === field);
  const hasStaticBoxLock = (node.lockedMoveAxes || []).includes(axis);
  return hasConstraint || hasStaticBoxLock;
}

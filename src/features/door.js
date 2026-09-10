/**
 * features/door.js
 *
 * A DOOR is a new panel that closes a rectangular opening bounded by
 * 4 already-picked panels (see tools/boundaryRectTool.js +
 * shared/geometry.js#computeBoundaryRectangle) — the front-fitting
 * feature those files exist for. PURE MODULE, same rule as
 * features/box.js: nothing here touches the global `panels` array or
 * calls history/render; modeller-main.js applies whatever
 * computeDoorPlacement() returns.
 *
 * A door's own edgeFit uses the EXACT same shape/labels as a box
 * wall's edgeFit (features/box.js#DEFAULT_EDGE_FIT) —
 * left/right/bottom/top, each 'in' or 'out' — deliberately, so
 * ui/properties.js's existing Edge Fit control needs no door-specific
 * variant. left/right always mean "the edge along
 * computeBoundaryRectangle's axisA", bottom/top "along axisB" —
 * whichever 2 world axes those actually are depends on which wall the
 * door is replacing (see computeBoundaryRectangle's own doc comment).
 *
 * The actual opening-fitting math (edge fit -> footprint, boundary-
 * panel patches, interior-panel clearance) lives in
 * shared/frontFit.js#computeFrontFit — shared with features/drawer.js,
 * which fits N stacked drawer fronts into the exact same kind of
 * opening. This file layers door-specific concerns on top: exactly
 * one panel, a hinge side, and open/close swinging.
 */
import { createPanelNode } from '../modeller/modules.js';
import { computeBoundaryRectangle } from '../shared/geometry.js';
import { computeFrontFit, dimFieldForAxis, ROTATION_FOR_NORMAL_AXIS } from '../shared/frontFit.js';

export const DEFAULT_DOOR_EDGE_FIT = { left: 'in', right: 'in', bottom: 'in', top: 'in' };
export const DEFAULT_DOOR_HINGE = 'left';

export { ROTATION_FOR_NORMAL_AXIS };

/**
 * @param {Array} panels - current graph (passed to resolveConstraints)
 * @param {Object} boundaryResult - a successful (ok:true) result from
 *   shared/geometry.js#computeBoundaryRectangle (the 4-panel pick)
 * @param {{left:'in'|'out',right:'in'|'out',bottom:'in'|'out',top:'in'|'out'}} edgeFit
 * @param {{material:string, thicknessMm:number, hinge?:'left'|'right'}} doorSpec
 * @returns {{ ok: true, groupId: string, normalAxis: string,
 *   door: { axisA, axisB, aMin, aMax, bMin, bMax, centerN, thicknessMm, material, hinge, doorSign },
 *   panelPatches: [{ id: string, dimField?: string, width?: number, height?: number, thickness?: number, centerN: number }] }
 *  | { ok: false, reason: 'invalid-boundary-result' | 'not-resolved' | 'degenerate' | 'panel-too-short' }}
 */
export function computeDoorPlacement(panels, boundaryResult, edgeFit, doorSpec) {
  const front = computeFrontFit(panels, boundaryResult, edgeFit, doorSpec.thicknessMm);
  if (!front.ok) return front;

  return {
    ok: true,
    groupId: front.groupId,
    normalAxis: front.normalAxis,
    door: {
      axisA: front.axisA,
      axisB: front.axisB,
      aMin: front.aMin,
      aMax: front.aMax,
      bMin: front.bMin,
      bMax: front.bMax,
      centerN: front.centerN,
      thicknessMm: doorSpec.thicknessMm,
      material: doorSpec.material,
      hinge: doorSpec.hinge === 'right' ? 'right' : DEFAULT_DOOR_HINGE,
      doorSign: front.sign, // which way the door's own outer face points — see computeDoorOpenTransform below, which reuses this instead of re-deriving it
      edgeFit: front.edgeFit, // the fully-defaulted fit actually used — createDoorNode stores this on the node so a later recompute reuses the SAME fit rather than falling back to DEFAULT_DOOR_EDGE_FIT
      // The 4 boundary panels' own ids, keyed the same way
      // shared/frontFit.js#edgeSides is — createDoorNode stores these
      // on the door node so a later relayout
      // (features/box.js#relayoutBox) can look the SAME 4 panels back
      // up and recompute this door from scratch against their new
      // geometry, instead of the door being frozen at whatever it was
      // computed as the moment it was created. See
      // computeDoorRecompute/applyDoorAdjustmentsForGroup below.
      boundaryIds: front.boundaryIds,
    },
    panelPatches: front.panelPatches,
  };
}

// The width/height/offset a door's node should have for a given
// placement result — shared by createDoorNode (a brand new node) and
// applyDoorAdjustmentsForGroup below (recomputing an EXISTING one),
// so the two can never silently drift apart.
function doorGeometryPatch(placement, basePosition) {
  const rotation = ROTATION_FOR_NORMAL_AXIS[placement.normalAxis];
  const widthField = dimFieldForAxis(rotation, placement.door.axisA);
  const heightField = dimFieldForAxis(rotation, placement.door.axisB);

  const absoluteCenter = { x: 0, y: 0, z: 0 };
  absoluteCenter[placement.door.axisA] = (placement.door.aMin + placement.door.aMax) / 2;
  absoluteCenter[placement.door.axisB] = (placement.door.bMin + placement.door.bMax) / 2;
  absoluteCenter[placement.normalAxis] = placement.door.centerN;

  return {
    [widthField]: placement.door.aMax - placement.door.aMin,
    [heightField]: placement.door.bMax - placement.door.bMin,
    offset: {
      x: absoluteCenter.x - basePosition.x,
      y: absoluteCenter.y - basePosition.y,
      z: absoluteCenter.z - basePosition.z,
    },
  };
}

/**
 * Builds the actual new door panel node from a computeDoorPlacement()
 * result. Shares the SAME basePosition every other panel in the group
 * already uses (found from `panels`) — offsets are only ever
 * meaningful relative to that one shared anchor (see
 * features/box.js#addBox's own comment on this).
 */
export function createDoorNode(panels, placement) {
  const basePosition = panels.find((p) => p.groupId === placement.groupId)?.basePosition || { x: 0, y: 0, z: 0 };
  const rotation = ROTATION_FOR_NORMAL_AXIS[placement.normalAxis];

  const node = createPanelNode({
    name: 'Door',
    isDoor: true, // distinguishes a door from a renamed plain panel — restoreFace() in modeller-main.js checks this, not the name, since the person can rename a door via the normal rename UI
    thickness: placement.door.thicknessMm,
    material: placement.door.material,
    rotation,
    groupId: placement.groupId,
    isBoxPanel: true,
    // A door's whole size and position are DERIVED from its 4
    // boundary panels + its own edgeFit (see applyDoorAdjustmentsForGroup
    // below) — never something to drag or type a number into
    // directly. The REAL, working lockdown is modeller/gizmos.js's
    // isDoor(mesh) check (mirrors its isBoxWall(mesh) one) — that's
    // what actually hides the resize-handle dots and move arrows,
    // since resize locking has no data-driven path at all here (a
    // node's lockedFields.width/height only ever get set by an actual
    // spansBetween/attachedTo constraint — a door has none, its
    // geometry is baked as literal numbers). lockedMoveAxes below is
    // set anyway, for the ONE thing that IS data-driven:
    // resolveConstraints turns an axis in lockedMoveAxes into
    // lockedFields.positionX/Y/Z on the resolved node (see
    // modeller/snap.js#emptyResolved), which ui/properties.js's own
    // Transform section already reads to show the position fields as
    // read-only — belt-and-suspenders with the gizmo's own check.
    lockedMoveAxes: ['x', 'y', 'z'],
  });
  // Everything computeDoorOpenTransform below needs to swing this
  // exact door open later, without re-deriving anything from the (by
  // then possibly-changed) boundary panels — hinge is the one thing
  // the person actually chooses; normalAxis/doorSign are just this
  // placement's own already-computed values, carried along.
  node.hinge = placement.door.hinge;
  node.doorOpen = false;
  node.normalAxis = placement.normalAxis;
  node.doorSign = placement.door.doorSign;
  // Both needed by computeDoorRecompute/applyDoorAdjustmentsForGroup
  // below to rebuild this exact door from scratch after the box
  // itself changes — see that function's own doc comment.
  node.edgeFit = placement.door.edgeFit;
  node.boundaryIds = placement.door.boundaryIds;

  node.basePosition = basePosition;
  Object.assign(node, doorGeometryPatch(placement, basePosition));

  return node;
}

/**
 * Given a door's CLOSED resolved geometry (position/rotation/width/
 * height, absolute mm — as produced by resolveConstraints, plus its
 * own normalAxis/hinge/doorSign carried through from createDoorNode
 * above) returns the position+rotation to render it OPEN instead —
 * swung 90° about a VERTICAL (world Y) line running through its hinge
 * edge, outward, away from the box (the same direction doorSign
 * already points).
 *
 * Purely a VISUAL substitution: modeller-main.js's renderAll() calls
 * this only for the 3D scene's own copy of the panel list, never for
 * the array BOM/cut-list/the panel list itself read — a door's actual
 * stored width/height/thickness never change just because it's shown
 * open, and nothing here is persisted; toggling doorOpen back to
 * false trivially returns to the exact closed transform because this
 * is recomputed from scratch on every render, not stored.
 *
 * "left"/"right" refers to the horizontal in-plane axis' own
 * coordinate ordering (near/far, smaller/larger mm) — see
 * edgeSides() above — not necessarily left/right as a person standing
 * in a specific spot would call it; refine if that ever needs to
 * match a specific viewing convention instead.
 *
 * Only meaningful when normalAxis is 'x' or 'z' — a door whose
 * normalAxis is 'y' (replacing a Top/Bottom wall, lying flat like a
 * lid) has no vertical edge to hinge on, so this returns null and the
 * caller should just render it closed.
 */
export function computeDoorOpenTransform(door) {
  if (!door.normalAxis || door.normalAxis === 'y') return null;

  const horizontalAxis = ['x', 'y', 'z'].find((a) => a !== door.normalAxis && a !== 'y');
  const widthField = dimFieldForAxis(door.rotation, horizontalAxis);
  const halfWidth = door[widthField] / 2;
  const doorSign = door.doorSign || 1;

  const hingeCoord = door.hinge === 'right'
    ? door.position[horizontalAxis] + halfWidth
    : door.position[horizontalAxis] - halfWidth;

  const position = { ...door.position };
  position[horizontalAxis] = hingeCoord; // the hinge edge itself never moves
  position[door.normalAxis] = door.position[door.normalAxis] + doorSign * halfWidth; // swings outward, away from the box, by its own half-width

  return { rotation: ROTATION_FOR_NORMAL_AXIS[horizontalAxis], position };
}

// Whether `node`'s given dimField is governed by an ACTIVE spansBetween
// constraint rather than being a free literal value — e.g. a shelf's
// depth, always spanning Back-to-Front (see features/shelf.js#addShelf's
// spanToDepth). A literal patch to such a field gets silently discarded
// the very next render: resolveConstraints recomputes a constrained
// field from the constraint itself (modeller/snap.js#applySpansBetween),
// ignoring whatever literal value is sitting on the node. This is
// exactly why a shelf used to slide right through a door while a box
// wall correctly receded — box walls have no such constraint at all
// (features/box.js's own "STAGE 3: pure arithmetic, no spansBetween"
// design), so a literal patch stuck for them but never for a shelf.
function findDimFieldConstraint(node, dimField) {
  return (node.constraints || []).find((c) => !c.overridden && c.type === 'spansBetween' && c.field === dimField);
}

/**
 * Applies ONE panelPatch (from computeDoorPlacement's panelPatches
 * array) to `panels`, returning a new array. Shared by
 * modeller-main.js's door-creation commit and
 * applyDoorAdjustmentsForGroup below, so there's exactly one place
 * that knows how to actually write a patch onto a panel.
 *
 * Two cases:
 *  - No constraint on `dimField` (a box wall — see
 *    features/box.js's own doc comment on why): patch the literal
 *    field + offset directly, exactly as before.
 *  - An ACTIVE spansBetween constraint on `dimField` (a shelf): the
 *    literal field is not the source of truth, so patch the
 *    CONSTRAINT's own `from`/`to` offset instead, by exactly the
 *    delta needed to move that endpoint from its old position to the
 *    new one — resolveConstraints then derives the correct (already-
 *    shrunk) field value naturally on every future render, the same
 *    way it always has for anything else spansBetween governs.
 *    Assumes `from` anchors the MIN (more negative) end and `to`
 *    anchors the MAX end — true for every spansBetween this app
 *    currently creates on a door-relevant axis (spanToDepth's
 *    from=Back, to=Front, and Back is always more negative than
 *    Front by construction). A shelf's OTHER constraint
 *    (spanToBoundaries, spanning its two picked side-boundary panels)
 *    isn't guaranteed that ordering and isn't covered by this — no
 *    door built so far needs a shelf's span-between-sides edge to
 *    shrink, only its depth.
 */
export function applyPanelPatch(panels, patch, normalAxis) {
  const node = panels.find((p) => p.id === patch.id);
  if (!node) return panels;

  const constraint = findDimFieldConstraint(node, patch.dimField);
  if (constraint) {
    const fromDelta = patch.newMin - patch.oldMin; // >0 shrinks in from the 'from' (min) end
    const toDelta = patch.oldMax - patch.newMax; // >0 shrinks in from the 'to' (max) end
    if (Math.abs(fromDelta) < 0.001 && Math.abs(toDelta) < 0.001) return panels; // nothing actually changed — skip the no-op map/spread

    return panels.map((p) => {
      if (p.id !== node.id) return p;
      const constraints = (p.constraints || []).map((c) => (c.id !== constraint.id ? c : {
        ...c,
        from: { ...c.from, offset: (c.from.offset || 0) + fromDelta },
        to: { ...c.to, offset: (c.to.offset || 0) + toDelta },
      }));
      return { ...p, constraints };
    });
  }

  return panels.map((p) => (p.id === node.id
    ? { ...p, [patch.dimField]: patch.newMax - patch.newMin, offset: { ...p.offset, [normalAxis]: patch.centerN } }
    : p));
}

/**
 * Re-derives a door's placement from scratch, using its OWN stored
 * boundaryIds/edgeFit/hinge/material/thickness against the boundary
 * panels' CURRENT (possibly just-changed) geometry — the exact same
 * math computeDoorPlacement always does, just re-entered with
 * everything the original tools/doorTool.js confirm step captured
 * instead of a fresh user pick. Returns the same shape
 * computeDoorPlacement does; `{ ok:false, reason:'boundary-missing' }`
 * if one of the 4 original boundary panels no longer exists (e.g. a
 * shelf that was used as a boundary got deleted) — the caller should
 * just leave that door at its last-known geometry rather than crash.
 */
export function computeDoorRecompute(panels, doorNode) {
  if (!doorNode.boundaryIds) return { ok: false, reason: 'no-boundary-ids' };

  const boundaryNodes = Object.values(doorNode.boundaryIds).map((id) => panels.find((p) => p.id === id));
  if (boundaryNodes.some((n) => !n)) return { ok: false, reason: 'boundary-missing' };

  const boundaryResult = computeBoundaryRectangle(panels, boundaryNodes);
  if (!boundaryResult.ok) return boundaryResult;

  return computeDoorPlacement(panels, boundaryResult, doorNode.edgeFit, {
    material: doorNode.material,
    thicknessMm: doorNode.thickness,
    hinge: doorNode.hinge,
  });
}

/**
 * Re-applies EVERY door in `groupId` against the CURRENT graph —
 * meant to run right after features/box.js#relayoutBox's own patches
 * are applied (see modeller-main.js#applyRelayoutResult), because
 * relayoutBox unconditionally recomputes all 6 box walls from
 * scratch on every call and has no idea a door once required some of
 * them to be shorter. Without this, the very next box edit after
 * placing a door (resizing it, changing Front's edgeFit, anything
 * that touches relayoutBox) would silently erase the door's own
 * shrinkage of its boundary panels, letting the door interpenetrate
 * them again.
 *
 * KNOWN LIMITATION: doors are processed one at a time, each reading
 * whatever the previous one already wrote — correct for the common
 * case (doors on independent boundaries, or a single door), but two
 * doors that happen to share a boundary panel AND axis would apply
 * their own 'out' shrinkage on top of each other's rather than
 * resolving to one shared target. Nothing built so far creates that
 * situation; flagged here rather than solved speculatively.
 */
export function applyDoorAdjustmentsForGroup(panels, groupId) {
  let next = panels;
  const doors = next.filter((p) => p.groupId === groupId && p.isDoor);

  for (const door of doors) {
    const placement = computeDoorRecompute(next, door);
    if (!placement.ok) continue; // leave it exactly as it was rather than erase/break it

    placement.panelPatches.forEach((patch) => {
      next = applyPanelPatch(next, patch, placement.normalAxis);
    });

    const doorPatch = doorGeometryPatch(placement, door.basePosition);
    next = next.map((p) => (p.id === door.id ? { ...p, ...doorPatch, doorSign: placement.door.doorSign } : p));
  }

  return next;
}

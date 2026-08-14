/**
 * Entry point for the modeller page. This is the only file that is
 * allowed to mutate `panels` — every module above only reads data or
 * fires callbacks back up here. That single-writer rule is what
 * keeps "graph -> view" one-directional as this grows.
 *
 * STAGE 2: `renderAll()` now runs `resolveConstraints(panels)` once
 * per render — this is THE seam where raw graph (literals +
 * constraints) becomes resolved graph (concrete numbers everywhere).
 * scene.reconcile(), computeBom(), and renderPanelList() all consume
 * the RESOLVED array; only renderProperties() sees the raw node too,
 * since the inspector is the one place that needs to know a
 * constraint exists at all (to render it locked, and to offer
 * "Unlink").
 */
import {
  createPanelNode,
  computeNextBasePosition,
  computeWorldHalfExtents,
  FLOOR_MM,
  DESIGN_LIMITS_MM,
  PANEL_SIZE_LIMITS_MM,
  MATERIAL_CATALOG,
  nextConstraintId,
  FACE_TO_DIM_FIELD,
  getAlignedAxis,
  LOCAL_FACES,
} from './modeller/modules.js';
import { resolveConstraints } from './modeller/snap.js';
import { createModellerScene } from './modeller/scene.js';
import { getSelectedId, setSelectedId, getSelectedGroupId, setSelectedGroupId } from './modeller/selection.js';
import { computeBom } from './engine/bom.js';
import { renderProperties } from './ui/properties.js';
import { renderPanelList } from './ui/toolbar.js';
import { renderRelations } from './ui/relations.js';
import { initResizableLayout } from './ui/layout.js';

initResizableLayout();

// ---- THE GRAPH ----
// Initial state: one box, rather than two bare panels — see addBox()
// below and the addBox() call at the very end of this file (after
// every other module-level const/function this needs has been
// defined; addBox() itself calls renderAll(), so nothing else is
// needed here).
let panels = [];

// Ctrl/Cmd-click — in the panel list OR either 2D/3D view — toggles
// membership here; "Group selected" (see groupSelectedPanels below)
// turns the current set into a real group and clears it. Only ever
// holds STANDALONE panel ids — Ctrl-clicking an already-grouped panel
// is a no-op for this pass (grouping an already-grouped panel into
// another group, or merging two groups, isn't handled yet).
const multiSelectedIds = new Set();

// Snapshot of each member's offset at the moment a GROUP drag begins
// (see onGroupDragStart below). The delta reported during the drag is
// cumulative-since-drag-start, not a per-frame increment — so every
// high-frequency update must REPLACE each member's offset as
// (snapshot + delta), never just add the delta onto whatever offset
// is already stored, or it would compound every single frame.
let groupDragStartOffsets = null; // Map<nodeId, {x,y,z}> | null

// -------------------------------------------------------------
// Design limits (DESIGN_LIMITS_MM, in modules.js): the overall space
// a design may occupy, checked at every edit entry point below — not
// a view/camera clipping limit. Move-drags CLAMP per axis (so the
// panel slides smoothly and just stops at the wall); resize-drags and
// typed inspector fields REJECT the whole edit outright (simpler and
// clearer than silently shrinking a typed value to whatever fits).
// -------------------------------------------------------------
const AXIS_LABEL = { x: 'width (X)', y: 'height (Y)', z: 'depth (Z)' };
const designLimitToastEl = document.getElementById('design-limit-toast');
let designLimitHideTimer = null;

// Shared toast plumbing for every short-lived status/error message in
// this file (design-limit hits, panel-size hits, and — see
// startCollinearMode below — the collinear tool's own "select a
// face..." guidance). `autoHide` distinguishes a self-clearing error
// flash from a STATUS message that should stay up until the caller
// explicitly changes or clears it (e.g. while a multi-step pick is
// still in progress).
function showToast(text, autoHide = true) {
  designLimitToastEl.textContent = text;
  designLimitToastEl.classList.add('visible');
  clearTimeout(designLimitHideTimer);
  if (autoHide) {
    designLimitHideTimer = setTimeout(() => designLimitToastEl.classList.remove('visible'), 2200);
  }
}
function hideToast() {
  clearTimeout(designLimitHideTimer);
  designLimitToastEl.classList.remove('visible');
}

function showDesignLimitError(axis) {
  showToast(`Design limit reached for ${AXIS_LABEL[axis]}`);
}

function applyBoxResize(sourceNodeId, deltaMm) {
  const source = panels.find((p) => p.id === sourceNodeId);
  if (!source) return;

  const nextOffset = {
    ...source.offset,
    x: source.offset.x + deltaMm.x,
    y: source.offset.y + deltaMm.y,
    z: source.offset.z + deltaMm.z,
  };

  const { offset, hitAxis } =
    clampOffsetToDesignLimits(source, nextOffset);

  updateNode(sourceNodeId, {
    offset,
  });

  if (hitAxis) {
    showDesignLimitError(hitAxis);
  }
}

// Move-drags: clamps the PROPOSED offset per axis against the panel's
// own true world-space size (computeWorldHalfExtents accounts for
// rotation — a Horizontal panel's thickness is what extends along Z,
// not its width). basePosition never changes, so it's always the
// correct zero-offset reference to clamp relative to.
function clampOffsetToDesignLimits(node, proposedOffset) {
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
function clampGroupOffsetToDesignLimits(members, startOffsets, proposedDeltaMm) {
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
function findPanelSizeViolation(dims) {
  if (dims.width > PANEL_SIZE_LIMITS_MM.width) return 'width';
  if (dims.height > PANEL_SIZE_LIMITS_MM.height) return 'height';
  return null;
}

function showPanelSizeLimitError(field) {
  showToast(`Maximum panel ${field} is ${PANEL_SIZE_LIMITS_MM[field]}mm`);
}

// Resize-drags and typed fields: outright rejects if the FINAL
// position + dimensions would violate any axis — returns the
// offending axis, or null if the edit is fine as proposed.
function findDesignLimitViolation(rotation, positionMm, dims) {
  const halfExtents = computeWorldHalfExtents({ rotation, ...dims });
  for (const axis of ['x', 'y', 'z']) {
    const limit = DESIGN_LIMITS_MM[axis];
    const min = positionMm[axis] - halfExtents[axis];
    const max = positionMm[axis] + halfExtents[axis];
    if (min < limit.min - 0.01 || max > limit.max + 0.01) return axis;
  }
  return null;
}

// ---- DOM refs ----
const canvas = document.getElementById('canvas');
const main = document.getElementById('main');
const panelListMountEl = document.getElementById('panel-list-mount');
const relationsMountEl = document.getElementById('relations-mount');
const inspectorEl = document.getElementById('properties-container');
const bomBodyEl = document.getElementById('bom-body');
const stageLabelEl = document.getElementById('stage-label');
const axesCanvas = document.getElementById('axes-gizmo-canvas');
const pipCanvas = document.getElementById('pip-canvas');

// ---- Scene (view layer). Consumes RESOLVED panels only. ----
const { reconcile, setViewMode, setFacePickMode, setFaceHighlight, setPanelHighlight } = createModellerScene(canvas, main, {
  axesCanvas,
  pipCanvas,
  onPipModeClick: (mode) => switchView(mode),
  onSelect: handleCanvasSelectClick,
  onTransformChange: (nodeId, transform) => {
    const node = panels.find((p) => p.id === nodeId);
    if (!node) return;

    const offset = transform.offset
    // const offset = {
    //   x: transform.position.x / MM_TO_UNIT - node.basePosition.x,
    //   y: transform.position.y / MM_TO_UNIT - node.basePosition.y,
    //   z: transform.position.z / MM_TO_UNIT - node.basePosition.z,
    // };

    const { offset: clampedOffset, hitAxis } =
      clampOffsetToDesignLimits(node, offset);

    updateNode(nodeId, {
      offset: clampedOffset,
      rotation: transform.rotation,
    });

    if (nodeId === getSelectedId()) {
      renderInspectorOnly();
    }

    if (hitAxis) {
      showDesignLimitError(hitAxis);

      return {
        x: (node.basePosition.x + clampedOffset.x) * MM_TO_UNIT,
        y: (node.basePosition.y + clampedOffset.y) * MM_TO_UNIT,
        z: (node.basePosition.z + clampedOffset.z) * MM_TO_UNIT,
      };
    }
  },
  onGroupDragStart: (nodeIds) => {
    groupDragStartOffsets = new Map(
      nodeIds.map((id) => {
        const p = panels.find((pp) => pp.id === id);
        return [id, p ? { ...p.offset } : { x: 0, y: 0, z: 0 }];
      })
    );
  },
  onGroupTransformChange: (nodeIds, deltaMm) => {
    // High-frequency during drag, same lightweight-patch approach as
    // onTransformChange — just fanned out to every member at once,
    // each replaced from ITS OWN drag-start snapshot + the shared
    // (now scene-bounds-clamped) delta (see groupDragStartOffsets
    // above for why this must be a replace, not an accumulate).
    if (!groupDragStartOffsets) return; // drag start snapshot missing — ignore rather than guess

    const members = nodeIds.map((id) => panels.find((p) => p.id === id)).filter(Boolean);
    const { delta: clampedDeltaMm, hitAxis } = clampGroupOffsetToDesignLimits(
      members,
      groupDragStartOffsets,
      deltaMm
    );

    panels = panels.map((p) => {
      const start = groupDragStartOffsets.get(p.id);
      if (!start) return p;
      return {
        ...p,
        offset: {
          x: start.x + clampedDeltaMm.x,
          y: start.y + clampedDeltaMm.y,
          z: start.z + clampedDeltaMm.z,
        },
      };
    });

    if (hitAxis) {
      showDesignLimitError(hitAxis);
      return clampedDeltaMm; // tells gizmos.js/view2d.js to snap the live meshes back to this clamped value
    }
  },
  onDimensionChange: (nodeId, dims, offsetDeltaMm) => applyDimensionChange(nodeId, dims, offsetDeltaMm),
});

// Shared by the gizmo/edge-drag onDimensionChange callback above AND
// the collinear tool below (applyCollinear) — validates a proposed
// width/height/thickness + offset delta against both per-panel size
// caps and the overall scene bounds, and only then commits it.
// Returns true if applied, false if rejected (a toast has already
// been shown either way it's rejected).
function applyDimensionChange(nodeId, dims, offsetDeltaMm) {
  const current = panels.find((p) => p.id === nodeId);
  if (!current) return false;
  const proposedOffset = offsetDeltaMm
    ? {
        x: current.offset.x + (offsetDeltaMm.x || 0),
        y: current.offset.y + (offsetDeltaMm.y || 0),
        z: current.offset.z + (offsetDeltaMm.z || 0),
      }
    : current.offset;
  const sizeViolation = findPanelSizeViolation(dims);
  if (sizeViolation) {
    // Same rejection path as a design-limit hit — gizmos.js/view2d.js
    // already reset the mesh's transient scale/position to pre-drag
    // values before calling this.
    showPanelSizeLimitError(sizeViolation);
    return false;
  }
  const proposedPositionMm = {
    x: current.basePosition.x + proposedOffset.x,
    y: current.basePosition.y + proposedOffset.y,
    z: current.basePosition.z + proposedOffset.z,
  };
  const hitAxis = findDesignLimitViolation(current.rotation, proposedPositionMm, dims);
  if (hitAxis) {
    // Reject outright — gizmos.js/view2d.js already reset the mesh's
    // transient scale/position to pre-drag values before calling
    // this, so there's nothing further to visually correct.
    showDesignLimitError(hitAxis);
    return false;
  }
  updateNode(nodeId, { width: dims.width, height: dims.height, thickness: dims.thickness, offset: proposedOffset });
  renderAll();
  return true;
}

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
let collinearActive = false;
let collinearPick1 = null; // { nodeId, faceName, axis, sign, dimField } | null
let collinearGapMm = 0; // user-editable, see the toolbar's own gap input — read fresh at commit time, not captured per-pick, so changing it mid-pick before the second click still applies
const AXIS_TO_POSITION_FIELD = { x: 'positionX', y: 'positionY', z: 'positionZ' };

function startCollinearMode() {
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

function cancelCollinearMode() {
  collinearActive = false;
  collinearPick1 = null;
  setSelectedId(null);
  setFacePickMode(false, null);
  hideToast();
  renderAll();
}

// -------------------------------------------------------------
// SHELF TOOL — box-only. Pick two BOUNDARY panels on the same axis and
// creates a new shelf spanning between them, joined into the SAME box
// group, with its depth automatically spanning to the box's Back/
// Front. A boundary panel for a HORIZONTAL shelf (spans the X axis)
// is Left, Right, or any EXISTING Vertical-rotation shelf already in
// that box — so e.g. picking Right + an existing vertical divider
// creates a shelf filling just that one compartment, not the whole
// box. Symmetrically, a VERTICAL shelf's boundary is Top, Bottom, or
// any existing Horizontal-rotation shelf. Reuses the exact same
// pick-mode plumbing as the collinear tool (setFacePickMode/
// setFaceHighlight) — the two are mutually exclusive single-slot
// tools, never active together.
//
// Like collinear, this is built entirely from live constraints
// (spansBetween referencing whichever two boundary panels were
// picked, plus the box's own Back/Front for depth), never a one-time
// snapshot — so if either boundary is resized or moved afterward
// (an ordinary drag, the resizeProxy redirect, collinear, or another
// shelf being dragged), this shelf's width/height re-resolves right
// along with it. No cycle risk: a shelf only ever depends on
// panels that existed before it — it can be a boundary for a LATER
// shelf, but never for one that already depends on it (the pick
// flow can't reference a not-yet-created node), so the dependency
// graph only ever grows forward, never back on itself.
// -------------------------------------------------------------
let shelfMode = null; // 'horizontal' | 'vertical' | null
let shelfPick1 = null; // the raw panel node (from `panels`, not resolved) of the first pick

// A panel's ROTATION, not its name, is what makes it a valid boundary
// — this is what lets an existing shelf stand in for Left/Right/Top/
// Bottom. Left/Right and any "Shelf (V)" all share the same rotation
// as VERTICAL_ROTATION (declared further down, alongside
// createAndSelectPanel — safe to reference here since this is only
// ever read once these functions are actually CALLED, well after the
// whole module has finished loading); Top/Bottom and any "Shelf (H)"
// share HORIZONTAL_ROTATION.
const SHELF_BOUNDARY_ROTATION = { horizontal: () => VERTICAL_ROTATION, vertical: () => HORIZONTAL_ROTATION };

function rotationsMatch(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function startShelfMode(mode) {
  if (collinearActive) cancelCollinearMode(); // mutually exclusive — see collinear's own note above
  shelfMode = mode;
  shelfPick1 = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  multiSelectedIds.clear();
  setFaceHighlight(null, null);
  setFacePickMode(true, handleShelfPick);
  const kind = mode === 'horizontal' ? 'Left/Right (or an existing vertical shelf)' : 'Top/Bottom (or an existing horizontal shelf)';
  showToast(`${mode === 'horizontal' ? 'Horizontal' : 'Vertical'} shelf: pick a box's ${kind}`, false);
  renderAll();
}

function cancelShelfMode() {
  shelfMode = null;
  shelfPick1 = null;
  setSelectedId(null);
  setFaceHighlight(null, null);
  setFacePickMode(false, null);
  hideToast();
  renderAll();
}

// `faceName` is accepted (same callback shape setFacePickMode always
// uses) but deliberately unused for anything functional beyond the
// highlight — this tool only cares WHICH PANEL was picked, not which
// specific face; the actual touching faces get computed dynamically
// in addShelf below, from the two panels' real resolved positions.
function handleShelfPick(nodeId, faceName) {
  const node = panels.find((p) => p.id === nodeId);
  if (!node) return;

  const wantRotation = SHELF_BOUNDARY_ROTATION[shelfMode]();
  const kindLabel = shelfMode === 'horizontal' ? 'a Left/Right panel or an existing vertical shelf' : 'a Top/Bottom panel or an existing horizontal shelf';
  if (!node.groupId || !rotationsMatch(node.rotation, wantRotation)) {
    showToast(`Pick ${kindLabel}`);
    return; // stays armed — an invalid pick doesn't cancel the tool, just doesn't register
  }

  if (!shelfPick1) {
    shelfPick1 = node;
    // setFaceHighlight(nodeId, faceName);
    setPanelHighlight(nodeId, faceName);
    showToast(`Now pick the OTHER boundary of the SAME box (${kindLabel})`, false);
    renderAll();
    return;
  }

  if (shelfPick1.id === nodeId) {
    showToast('Pick a DIFFERENT panel, not the same one again');
    return;
  }
  if (shelfPick1.groupId !== node.groupId) {
    showToast('Both panels must belong to the same box');
    return;
  }

  addShelf(shelfPick1, node);
  cancelShelfMode();
}

// Box siblings are found by groupId + role name (see addBox — every
// box panel is named exactly 'Left'/'Right'/'Top'/'Bottom'/'Back'/
// 'Front') rather than by any stored per-role id list, since that's
// already the single source of truth addBox itself relies on. Always
// the box's REAL Back/Front — a shelf's depth always reaches the
// actual box walls/door, never another shelf, regardless of which
// two boundary panels were picked for width/height.
function findBoxSibling(groupId, name) {
  return panels.find((p) => p.groupId === groupId && p.name === name);
}

// Which of a resolved node's LOCAL faces both (a) aligns with `axis`
// and (b) points TOWARD `otherResolved` — i.e. the one face of the
// two possible (+/-) candidates that actually faces the other picked
// boundary, determined from their real current positions rather than
// assumed from role/name. This is what makes picking an existing
// shelf as a boundary work exactly like picking Left/Right/Top/Bottom
// — it doesn't matter which literal side of the box either one is on.
function facingFace(resolved, axis, otherResolved) {
  const towardSign = Math.sign(otherResolved.position[axis] - resolved.position[axis]) || 1;
  for (const faceName of Object.keys(LOCAL_FACES)) {
    const aligned = getAlignedAxis(resolved.rotation, faceName);
    if (aligned && aligned.axis === axis && aligned.sign === towardSign) return faceName;
  }
  return null; // defensive — every panel in this app is axis-aligned, so one of the two candidate faces always matches
}

function addShelf(pick1, pick2) {
  const groupId = pick1.groupId;
  const back = findBoxSibling(groupId, 'Back');
  const front = findBoxSibling(groupId, 'Front');
  if (!back || !front) return; // defensive — shouldn't happen given handleShelfPick's own same-box validation

  const resolved = resolveConstraints(panels);
  const r1 = resolved.find((r) => r.id === pick1.id);
  const r2 = resolved.find((r) => r.id === pick2.id);
  if (!r1 || !r2) return;

  const spanAxis = shelfMode === 'horizontal' ? 'x' : 'y';
  const face1 = facingFace(r1, spanAxis, r2); // pick1's face pointing toward pick2
  const face2 = facingFace(r2, spanAxis, r1); // pick2's face pointing toward pick1
  if (!face1 || !face2) return;

  const spanFieldForBoundary = shelfMode === 'horizontal' ? 'width' : 'height'; // which field ON THE BOUNDARY PANELS this axis corresponds to — used only to size the shelf's OWN starting dims below, the live constraint itself just spans face-to-face
  const startWidthOrHeight = Math.abs(r2.position[spanAxis] - r1.position[spanAxis]); // rough starting size, purely cosmetic — the spansBetween constraint below immediately recomputes the true value on first resolve regardless

  const rotation = shelfMode === 'horizontal' ? HORIZONTAL_ROTATION : VERTICAL_ROTATION;
  const material = pick1.material;
  const thickness = pick1.thickness;

  const spanToBoundaries = {
    field: spanFieldForBoundary,
    type: 'spansBetween', overridden: false,
    from: { node: pick1.id, face: face1, offset: 0 },
    to: { node: pick2.id, face: face2, offset: 0 },
    id: nextConstraintId(),
  };
  const spanToDepth = shelfMode === 'horizontal'
    // Depth (this rotation's `height` field) spans directly to
    // Back/Front's own INNER faces — reaches from the back panel to
    // the front door automatically, and re-resolves live if either
    // ever moves.
    ? { field: 'height', type: 'spansBetween', overridden: false,
        from: { node: back.id, face: 'front', offset: 0 }, to: { node: front.id, face: 'back', offset: 0 }, id: nextConstraintId() }
    // Depth (this rotation's `width` field) — same idea, mirrored.
    : { field: 'width', type: 'spansBetween', overridden: false,
        from: { node: back.id, face: 'front', offset: 0 }, to: { node: front.id, face: 'back', offset: 0 }, id: nextConstraintId() };

  const shelf = createPanelNode({
    name: shelfMode === 'horizontal' ? 'Shelf (H)' : 'Shelf (V)',
    width: shelfMode === 'horizontal' ? startWidthOrHeight : DEFAULT_BOX_DEPTH_MM,
    height: shelfMode === 'horizontal' ? DEFAULT_BOX_DEPTH_MM : startWidthOrHeight,
    thickness, material, rotation,
    groupId,
    // Only the axis PERPENDICULAR to both constraints above (Y for a
    // horizontal shelf, X for a vertical one) is left free — that's
    // the whole point of this tool: where the shelf sits on that
    // axis isn't otherwise determined by the pick, so it stays a
    // literal, user-draggable field.
    lockedMoveAxes: shelfMode === 'horizontal' ? ['x', 'z'] : ['y', 'z'],
    constraints: [spanToBoundaries, spanToDepth],
  });

  // Default position on the free axis: the midpoint between the two
  // picked boundaries' CURRENT positions — reasonable regardless of
  // which two panels (box walls or existing shelves) were picked.
  // The other two axes get auto-centered by the constraints above on
  // the very first resolve regardless of what's set here.
  const anchor = pick1.basePosition;
  const freeAxis = shelfMode === 'horizontal' ? 'y' : 'x';
  const midpointMm = (r1.position[freeAxis] + r2.position[freeAxis]) / 2;
  shelf.basePosition = anchor;
  shelf.offset = { x: 0, y: 0, z: 0 };
  shelf.offset[freeAxis] = midpointMm - anchor[freeAxis];

  panels = [...panels, shelf];
  setSelectedGroupId(groupId);
  setSelectedId(shelf.id);
  renderAll();
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

function applyCollinear(pick1, pick2) {
  const node1 = panels.find((p) => p.id === pick1.nodeId);
  if (!node1) return false;

  const axis = pick1.axis;

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
    updateNode(pick1.nodeId, { constraints: [...otherConstraints, newConstraint] });
    renderAll(); // resolveConstraints picks up the new constraint immediately — if it happens to create a dependency cycle, the resolver already handles that gracefully (a warning on the affected node, not a crash) rather than needing special-cased detection here
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

  updateNode(pick1.nodeId, { constraints: [...otherConstraints, newConstraint] });
  renderAll();
  showToast('Movement was blocked — resized instead. This will keep re-adjusting automatically if the other panel changes.', false);
  return true;
}

// Escape cancels an in-progress collinear pick, same as it already
// does for nothing else in this app (no other modal/multi-step tool
// exists yet) — scoped narrowly so it can't interfere with anything.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && collinearActive) cancelCollinearMode();
  if (e.key === 'Escape' && shelfMode) cancelShelfMode();
});

// -------------------------------------------------------------
// 3D / 2D view mode toggle. Purely a rendering/interaction switch —
// nothing about the graph, resolver, BOM, or inspector changes
// based on which view is active.
// -------------------------------------------------------------
const view3dBtn = document.getElementById('view-3d-btn');
const view2dBtn = document.getElementById('view-2d-btn');
const hintBar3d = document.getElementById('hint-bar-3d');
const hintBar2d = document.getElementById('hint-bar-2d');

function switchView(mode) {
  setSelectedId(null); // deselect on every mode switch — no gizmo/handle can be left stuck
  setViewMode(mode);
  const is3d = mode === '3d';
  view3dBtn.classList.toggle('active', is3d);
  view2dBtn.classList.toggle('active', !is3d);
  hintBar3d.style.display = is3d ? '' : 'none';
  hintBar2d.style.display = is3d ? 'none' : '';
  renderAll();
}

view3dBtn.addEventListener('click', () => switchView('3d'));
view2dBtn.addEventListener('click', () => switchView('2d'));

// 'Delete' is what a browser reports for the key regardless of
// keyboard layout label — French AZERTY's "Suppr" key is the same
// physical/logical key, no separate handling needed. 'Backspace' is
// included too since many laptops (Mac especially) have no dedicated
// Delete key at all.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const active = document.activeElement;
  const isTyping =
    active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (isTyping) return; // don't hijack Backspace while editing a field's value
  if (!getSelectedId() && !getSelectedGroupId()) return;
  e.preventDefault();
  removeSelected();
});

// -------------------------------------------------------------
// Single generic graph-mutation primitive (Stage 2 consolidation:
// every function below patches `panels` through this one function
// instead of each hand-rolling its own `.map(...)`).
// -------------------------------------------------------------
function updateNode(id, patch) {
  panels = panels.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

// -------------------------------------------------------------
// Two-level selection: a group (e.g. the box) selects as a WHOLE
// unit first; clicking one of its members while already "inside"
// that group's context drills down to that specific panel. Standalone
// (non-grouped) panels always select directly, at one level.
//
// The 2D/3D canvas and the panel list need slightly different entry
// points because they have different affordances: the canvas has no
// way to show "you're now inside the box" except through the click
// itself (so it's progressive — same click target, different result
// depending on current context), while the list can just render the
// group and its members as separate, explicitly clickable rows (so a
// single click there always does exactly what that row says).
// -------------------------------------------------------------

function handleCanvasSelectClick(clickedId, ctrlKey) {
  if (!clickedId) {
    setSelectedGroupId(null);
    setSelectedId(null);
    renderAll();
    return;
  }
  const clicked = panels.find((p) => p.id === clickedId);
  if (!clicked) return;

  if (ctrlKey && !clicked.groupId) {
    // Ctrl/Cmd-click toggles multi-select (for building a NEW group
    // via groupSelectedPanels) — same restriction as the list: only
    // ever standalone panels, adding an already-grouped panel to
    // multi-select isn't handled yet.
    if (multiSelectedIds.has(clickedId)) multiSelectedIds.delete(clickedId);
    else multiSelectedIds.add(clickedId);
    renderAll();
    return;
  }

  if (!clicked.groupId) {
    // standalone panel — direct select, exit any group context
    setSelectedGroupId(null);
    setSelectedId(clickedId);
    renderAll();
    return;
  }

  if (getSelectedGroupId() === clicked.groupId) {
    // already "inside" this group's context (whether the group
    // itself was selected, or a sibling member was) — drill straight
    // into this specific panel
    setSelectedId(clickedId);
    renderAll();
    return;
  }

  // first click on this group from a neutral/different context —
  // select the GROUP as a whole, not any specific panel yet
  setSelectedGroupId(clicked.groupId);
  setSelectedId(null);
  renderAll();
}

function handleListSelectPanel(clickedId, ctrlKey) {
  const clicked = panels.find((p) => p.id === clickedId);
  if (!clicked) return;

  if (ctrlKey && !clicked.groupId) {
    if (multiSelectedIds.has(clickedId)) multiSelectedIds.delete(clickedId);
    else multiSelectedIds.add(clickedId);
    renderAll();
    return;
  }

  // A direct row click always selects exactly what it names — no
  // progressive drill-in needed, the list already shows the hierarchy
  // explicitly (group header row vs. indented member rows).
  multiSelectedIds.clear();
  setSelectedGroupId(clicked.groupId || null);
  setSelectedId(clickedId);
  renderAll();
}

function handleListSelectGroup(groupId) {
  multiSelectedIds.clear();
  setSelectedGroupId(groupId);
  setSelectedId(null);
  renderAll();
}

function groupSelectedPanels() {
  if (multiSelectedIds.size < 2) return;
  const ids = [...multiSelectedIds];
  const newGroupId = ids[0]; // reuse one member's own id as the group's identifier — no separate id generator needed, same trick addBox already uses
  panels = panels.map((p) => (ids.includes(p.id) ? { ...p, groupId: newGroupId } : p));
  multiSelectedIds.clear();
  setSelectedGroupId(newGroupId);
  setSelectedId(null);
  renderAll();
}

function ungroupSelected() {
  const groupId = getSelectedGroupId();
  if (!groupId) return;
  const formerMembers = panels.filter((p) => p.groupId === groupId).map((p) => p.id);
  // Restore any hidden faces first — once groupId is cleared, the
  // group-selected view (the only place a restore button exists)
  // won't be reachable for this panel anymore, so a still-hidden
  // member would become a permanently invisible orphan otherwise.
  panels = panels.map((p) => (p.groupId === groupId ? { ...p, groupId: null, hidden: false } : p));
  setSelectedGroupId(null);
  setSelectedId(formerMembers[0] || null); // land somewhere sensible rather than deselecting entirely
  renderAll();
}

function renderAll() {
  const selectedId = getSelectedId();
  const selectedGroupId = getSelectedGroupId();
  const resolved = resolveConstraints(panels); // unfiltered — a hidden panel still needs to resolve correctly so any sibling constraint referencing it stays accurate, and so it's instantly right again the moment it's restored
  const visiblePanels = resolved.filter((p) => !p.hidden);

  // Authoritative "is this a box wall" id set, sourced directly from
  // the raw graph (`panels`), NOT from the resolved output. Every box
  // wall is stamped isBoxWall:true exactly once, in addBox(), and
  // never touched again — so `panels` is always right here. The
  // RESOLVED node isn't a safe place to read this flag from:
  // resolveConstraints rebuilds each constrained node's fields and
  // isn't guaranteed to carry every custom flag through untouched —
  // which is exactly why resize dots were leaking through on some box
  // panels (the ones that actually go through constraint resolution,
  // e.g. Front) while others happened to still come through correctly.
  const boxWallIds = new Set(panels.filter((p) => p.isBoxWall).map((p) => p.id));

  reconcile(visiblePanels, selectedId, selectedGroupId, multiSelectedIds, boxWallIds);

  renderPanelList(panelListMountEl, {
    panels: visiblePanels,
    selectedId,
    selectedGroupId,
    onSelectPanel: handleListSelectPanel,
    onSelectGroup: handleListSelectGroup,
    multiSelectedIds,
    onGroupSelected: groupSelectedPanels,
    onAddVertical: addVerticalPanel,
    onAddHorizontal: addHorizontalPanel,
    onAddParallel: addParallelPanel,
    onAddBox: addBox,
    onCollinear: () => (collinearActive ? cancelCollinearMode() : startCollinearMode()),
    collinearActive,
    collinearGapMm,
    onCollinearGapChange: (mm) => { collinearGapMm = mm; }, // deliberately no renderAll() here — see toolbar.js's own comment on why
    onShelfHorizontal: () => (shelfMode === 'horizontal' ? cancelShelfMode() : startShelfMode('horizontal')),
    onShelfVertical: () => (shelfMode === 'vertical' ? cancelShelfMode() : startShelfMode('vertical')),
    shelfMode,
  });

  renderInspectorOnly();

  const rows = computeBom(visiblePanels);
  bomBodyEl.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${row.material} (${row.thickness}mm)</td>
        <td class="right">${row.quantity}</td>
        <td class="right">${row.areaM2.toFixed(3)}</td>
      </tr>`
    )
    .join('');

  stageLabelEl.textContent = `${visiblePanels.length} node(s) · constraints active`;
}

function renderInspectorOnly() {
  const selectedId = getSelectedId();
  const selectedGroupId = getSelectedGroupId();
  const selectedPanel = panels.find((p) => p.id === selectedId) || null;
  // Recomputed here too (not threaded from renderAll) so the
  // high-frequency onTransformChange path above always reflects the
  // current state of every field, not a stale snapshot.
  const resolved = resolveConstraints(panels);
  const resolvedPanel = resolved.find((r) => r.id === selectedId) || null;
  const groupMembers = selectedGroupId ? panels.filter((p) => p.groupId === selectedGroupId) : [];
  const visibleGroupMembers = groupMembers.filter((p) => !p.hidden);
  const hiddenGroupMembers = groupMembers.filter((p) => p.hidden);
  const groupMemberCount = visibleGroupMembers.length;
  // null (shown as "Mixed materials") if members currently disagree —
  // e.g. a group ungrouped-and-regrouped from panels that never had
  // their material unified. Never silently pick one to display.
  const groupMaterial =
    groupMembers.length > 0 && groupMembers.every((p) => p.material === groupMembers[0].material)
      ? groupMembers[0].material
      : null;

  renderProperties(inspectorEl, {
    selectedPanel,
    resolvedPanel,
    selectedGroupId,
    groupMemberCount,
    groupMaterial,
    hiddenGroupMembers,
    onFieldChange: updateSelectedField,
    onTransformFieldChange: updateSelectedTransformField,
    onUnlinkConstraint: unlinkOrRemoveConstraint,
    onRename: renameSelected,
    onRemove: removeSelected,
    onUngroup: ungroupSelected,
    onRestoreFace: restoreFace,
    onGroupMaterialChange: updateGroupMaterial,
  });

  renderRelations(relationsMountEl, {
    selectedPanel,
    allPanels: panels,
    onUnlinkConstraint: unlinkOrRemoveConstraint,
  });
}

function renameSelected(newName) {
  const trimmed = newName.trim();
  updateNode(getSelectedId(), { name: trimmed === '' ? null : trimmed });
  renderAll();
}

function updateSelectedField(field, value) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  if (field === 'material') {
    // The ONLY way thickness is allowed to change after a panel is
    // created — selecting a different material carries its own fixed
    // thickness with it (MATERIAL_CATALOG in modules.js). There's no
    // separate typed thickness field anywhere in the inspector.
    const catalogEntry = MATERIAL_CATALOG.find((m) => m.name === value);
    if (!catalogEntry) return; // dropdown only ever offers catalog entries — defensive, shouldn't happen
    const proposedDims = { width: node.width, height: node.height, thickness: catalogEntry.thicknessMm };
    const positionMm = {
      x: node.basePosition.x + node.offset.x,
      y: node.basePosition.y + node.offset.y,
      z: node.basePosition.z + node.offset.z,
    };
    const hitAxis = findDesignLimitViolation(node.rotation, positionMm, proposedDims);
    if (hitAxis) {
      showDesignLimitError(hitAxis);
      renderAll(); // revert the dropdown back to the stored (unchanged) material
      return;
    }
    updateNode(selectedId, { material: catalogEntry.name, thickness: catalogEntry.thicknessMm });
    renderAll();
    return;
  }

  if (['width', 'height'].includes(field)) {
    const proposedDims = {
      width: field === 'width' ? value : node.width,
      height: field === 'height' ? value : node.height,
      thickness: node.thickness,
    };
    const sizeViolation = findPanelSizeViolation(proposedDims);
    if (sizeViolation) {
      showPanelSizeLimitError(sizeViolation);
      renderAll(); // revert the inspector's input back to the stored (unchanged) value
      return;
    }
    const positionMm = {
      x: node.basePosition.x + node.offset.x,
      y: node.basePosition.y + node.offset.y,
      z: node.basePosition.z + node.offset.z,
    };
    const hitAxis = findDesignLimitViolation(node.rotation, positionMm, proposedDims);
    if (hitAxis) {
      showDesignLimitError(hitAxis);
      renderAll(); // revert the inspector's input back to the stored (unchanged) value
      return;
    }
  }

  updateNode(selectedId, { [field]: value });
  renderAll();
}

function updateGroupMaterial(materialName) {
  const groupId = getSelectedGroupId();
  if (!groupId) return;
  const catalogEntry = MATERIAL_CATALOG.find((m) => m.name === materialName);
  if (!catalogEntry) return; // dropdown only ever offers catalog entries — defensive, shouldn't happen

  const members = panels.filter((p) => p.groupId === groupId);

  // Pre-commit validation: check EVERY member before applying to ANY
  // of them. Thickness maps to a different world axis depending on
  // each member's own rotation (e.g. the box's left/right panels vs.
  // its back panel), so a material swap that's fine for one member
  // could still push a differently-rotated sibling past a design
  // limit — this must be checked per-member, not once for the group.
  for (const node of members) {
    const proposedDims = { width: node.width, height: node.height, thickness: catalogEntry.thicknessMm };
    const positionMm = {
      x: node.basePosition.x + node.offset.x,
      y: node.basePosition.y + node.offset.y,
      z: node.basePosition.z + node.offset.z,
    };
    const hitAxis = findDesignLimitViolation(node.rotation, positionMm, proposedDims);
    if (hitAxis) {
      showDesignLimitError(hitAxis);
      renderAll(); // revert the dropdown back to the stored (unchanged) material
      return;
    }
  }

  panels = panels.map((p) =>
    p.groupId === groupId ? { ...p, material: catalogEntry.name, thickness: catalogEntry.thicknessMm } : p
  );
  renderAll();
}

function updateSelectedTransformField(group, axis, value) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  if (group === 'offset') {
    const proposedOffset = { ...node.offset, [axis]: value };
    const { hitAxis } = clampOffsetToDesignLimits(node, proposedOffset);
    if (hitAxis) {
      showDesignLimitError(hitAxis);
      renderAll(); // revert the inspector's input back to the stored (unchanged) value
      return;
    }
  }

  updateNode(selectedId, { [group]: { ...node[group], [axis]: value } });
  renderAll();
}

// Orientation is decided at creation time now, not via a post-creation
// toggle — see the Vertical/Horizontal/Parallel buttons in the panel
// list. VERTICAL matches createPanelNode's own default rotation (a
// standing divider in the YZ plane); HORIZONTAL matches what the old
// Vertical/Horizontal inspector toggle produced for a flat shelf;
// PARALLEL is identity rotation — face lies in the XY plane,
// thickness along Z, same orientation the box preset already uses
// for its 'back' panel. Unlike the other two, a Parallel panel shows
// its full face (not an edge-on sliver) in the 2D front view, and
// both its width and height are 2D-edge-draggable there — see
// view2d.js, which derives this from rotation directly via
// getAlignedAxis rather than a hardcoded Vertical/Horizontal check.
const VERTICAL_ROTATION = { x: 0, y: 90, z: 0 };
const HORIZONTAL_ROTATION = { x: 90, y: 0, z: 0 };
const PARALLEL_ROTATION = { x: 0, y: 0, z: 0 };

function createAndSelectPanel(rotation) {
  const node = createPanelNode({ rotation });
  node.basePosition = computeNextBasePosition(resolveConstraints(panels), node);
  panels = [...panels, node];
  setSelectedId(node.id);
  renderAll();
}

function addVerticalPanel() {
  createAndSelectPanel(VERTICAL_ROTATION);
}

function addHorizontalPanel() {
  createAndSelectPanel(HORIZONTAL_ROTATION);
}

function addParallelPanel() {
  createAndSelectPanel(PARALLEL_ROTATION);
}

function removeSelected() {
  const groupId = getSelectedGroupId();
  const selectedId = getSelectedId();

  if (groupId && !selectedId) {
    // group-level selection (nothing drilled into) — this IS a real,
    // permanent delete of the whole group, unlike the single-face
    // case below.
    panels = panels.filter((p) => p.groupId !== groupId);
    setSelectedGroupId(null);
    setSelectedId(panels.length > 0 ? panels[0].id : null);
    renderAll();
    return;
  }

  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  if (node.groupId) {
    // panel-level selection WITHIN a group — HIDE it rather than
    // removing it from the graph. It stays fully present (constraints
    // involving it keep resolving normally) but is excluded from
    // rendering, the panel list, and the BOM — see renderAll's
    // `!p.hidden` filters. Restorable via a button in the group-level
    // inspector view (see properties.js's Group view + restoreFace
    // below). Step back up to group-level selection either way, since
    // there's nothing left to show for the now-hidden panel.
    panels = panels.map((p) => (p.id === selectedId ? { ...p, hidden: true } : p));
    setSelectedGroupId(node.groupId);
    setSelectedId(null);
    renderAll();
    return;
  }

  // plain standalone panel — a real, permanent removal (no group to
  // restore it through later)
  panels = panels.filter((p) => p.id !== selectedId);
  setSelectedId(panels.length > 0 ? panels[0].id : null);
  renderAll();
}

function restoreFace(nodeId) {
  panels = panels.map((p) => (p.id === nodeId ? { ...p, hidden: false } : p));
  renderAll();
}

// -------------------------------------------------------------
// Relation (constraint) CRUD — manual spansBetween/attachedTo
// creation used to live here (via a dropdown form in relations.js),
// but that's now fully superseded by the collinear tool (and the
// shelf tool, built on the same live-constraint approach) as the way
// to create these relations — see startCollinearMode/addShelf above.
// unlinkOrRemoveConstraint below is the one piece that's still
// needed: both the properties panel's "Unlink" control and the
// relations list's own remove (×) button use it to detach/delete an
// EXISTING relation, which is a distinct concern from authoring a new
// one by hand.
// -------------------------------------------------------------

// identifier is either a FIELD NAME (soft "Unlink" — mark the active
// constraint on that field overridden, keep its definition) or a
// CONSTRAINT ID with { remove: true } (hard delete regardless of
// override state).
function unlinkOrRemoveConstraint(identifier, opts = {}) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  if (opts.remove) {
    const nextConstraints = (node.constraints || []).filter((c) => c.id !== identifier);
    updateNode(selectedId, { constraints: nextConstraints });
    renderAll();
    return;
  }

  const field = identifier;
  const resolved = resolveConstraints(panels);
  const resolvedNode = resolved.find((r) => r.id === selectedId);
  const nextConstraints = (node.constraints || []).map((c) =>
    c.field === field && !c.overridden ? { ...c, overridden: true } : c
  );

  const patch = { constraints: nextConstraints };
  if (['width', 'height', 'thickness'].includes(field)) {
    // freeze the field at its current resolved value — no visual jump
    patch[field] = resolvedNode ? resolvedNode[field] : node[field];
  } else if (['positionX', 'positionY', 'positionZ'].includes(field)) {
    // position isn't a literal field — it's expressed via `offset`
    // (a delta from the node's own fixed basePosition). Convert the
    // current resolved absolute position back into the offset that
    // would reproduce it, so unlinking doesn't move the panel.
    const axis = field === 'positionX' ? 'x' : field === 'positionY' ? 'y' : 'z';
    const baseMm = node.basePosition[axis];
    const currentMm = resolvedNode ? resolvedNode.position[axis] : baseMm;
    patch.offset = { ...node.offset, [axis]: currentMm - baseMm };
  }
  updateNode(selectedId, patch);
  renderAll();
}

/**
 * Box preset: replaces the selected panel with 5 real panel nodes —
 * left, right, top, bottom, back — forming an open-front box.
 *
 * STAGE 2 REWRITE: top/bottom/back's WIDTH used to be a literal
 * number baked in once at creation time (Stage 1), computed by
 * hand-cancelling the auto-layout placeholder. It's now a REAL
 * `spansBetween` constraint against left/right — resize or drag
 * left/right apart later (via the width field, or the move gizmo)
 * and all three follow automatically. This is deliberately the
 * acceptance test for the resolver: it's the first real, useful
 * consumer of a constraint, not just a synthetic example.
 *
 * Depth positioning (Y/Z) is still literal offset + auto-layout, same
 * as the Stage 1 version — converting every dimension of the box to
 * a constraint is future work once this pattern is proven out.
 */
const DEFAULT_BOX_DEPTH_MM = 400;
const DEFAULT_BOX_WIDTH_MM = 500;
const DEFAULT_BOX_HEIGHT_MM = 700;

const BOX_GIZMO_LOCKS = {
  leftRight: {
    lockedMoveAxes: ['y', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: {
      positionY: true,
      positionZ: true,
    },
  },

  topBottom: {
    lockedMoveAxes: ['x', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: {
      positionX: true,
      positionZ: true,
    },
  },

  frontBack: {
    lockedMoveAxes: ['x', 'y'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: {
      positionX: true,
      positionY: true,
    },
  },
};

function isBoxWall(mesh) {
  return mesh?.userData?.isBoxWall === true;
}

function addBox() {
  const W = DEFAULT_BOX_WIDTH_MM;
  const H = DEFAULT_BOX_HEIGHT_MM;
  const D = DEFAULT_BOX_DEPTH_MM;
  const material = MATERIAL_CATALOG[0].name;
  const T = MATERIAL_CATALOG[0].thicknessMm;

  // NOTE ON AN EARLIER ATTEMPT AT THIS: a fully symmetric design (every
  // one of the 6 panels literal/free on its own outward normal, with
  // width/height fields cross-derived from the other four) was tried
  // and numerically verified against the real resolver — it produced
  // exactly correct geometry, but ALSO produced a per-node dependency
  // cycle (Left depends on Top for its height field; Top depends on
  // Left for its width field — two DIFFERENT fields, but the
  // resolver's cycle check is per-NODE, not per-field, so it can't
  // tell those apart and flags it circular regardless). The resolver
  // then falls back to frozen "last literal values" for every affected
  // panel — meaning it LOOKED right only because the initial values
  // happened to already be correct, not because it would actually
  // re-solve live if anything moved again. That's a real, tested dead
  // end, not a hunch — hence keeping left/right as the sole literal
  // "source of truth" below, unchanged from the original design.
  const collinearTo = (field, myFace, targetNode, targetFace, gapMm = 0) => ({
    field, type: 'attachedTo', overridden: false, myFace,
    from: { node: targetNode.id, face: targetFace, offset: gapMm },
    id: nextConstraintId(),
  });

  const left = createPanelNode({
    name: 'Left',
    width: D, height: H, thickness: T, material,
    rotation: { x: 0, y: 90, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.leftRight.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.leftRight.lockedResizeAxes,
    lockedFields: {...BOX_GIZMO_LOCKS.leftRight.lockedFields},
  });
  const right = createPanelNode({
    name: 'Right',
    width: D, height: H, thickness: T, material,
    rotation: { x: 0, y: 90, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.leftRight.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.leftRight.lockedResizeAxes,
    lockedFields: {...BOX_GIZMO_LOCKS.leftRight.lockedFields},
  });

  // Face choices verified directly against the resolver (see the
  // standalone test run while building this — with both side panels
  // rotated 90° about Y, LOCAL 'front'/'back' are the INNER faces
  // (facing into the box) and 'back'/'front' respectively are the
  // OUTER faces; LOCAL 'right'/'left' are the faces spanning each
  // side panel's OWN depth; LOCAL 'top'/'bottom' are their top/bottom
  // edges). Getting one wrong doesn't silently break — the resolver
  // rejects a genuinely misaligned face with a clear warning.
  //
  // Dependencies only ever flow FROM top/bottom/back TO left/right,
  // never the reverse — the resolver's cycle check is per-NODE, not
  // per-field, so even though "top depends on left for width" and "a
  // hypothetical left-depends-on-top for height" wouldn't actually
  // conflict value-wise, the resolver can't tell that and flags it as
  // circular anyway (see the note above — this was tested, not
  // assumed). Left/right stay the sole literal "source of truth"
  // panels; everything else derives from them.
  // For X, the literal source is the side-wall position rather than a
  // panel dimension (Left/Right width is the box depth after rotation).

  const nextId = () => nextConstraintId();

  // top/bottom span the OUTER faces — full width W, covering over
  // left/right's edges rather than being tucked between them.
  const outerWidthSpan = () => [{
    field: 'width', type: 'spansBetween', overridden: false,
    from: { node: left.id, face: 'back', offset: 0 },
    to: { node: right.id, face: 'front', offset: 0 },
    id: nextId(),
  }];
  // front keeps the original inner-fitted width (grooved between the
  // sides), W-2T.
  const innerWidthSpan = () => [{
    field: 'width', type: 'spansBetween', overridden: false,
    from: { node: left.id, face: 'back', offset: -T },
    to: { node: right.id, face: 'front', offset: -T },
    id: nextId(),
  }];
  // top/bottom's depth (their `height` field, since Horizontal
  // rotation maps height->Z) matches left's own depth directly —
  // spanning a single panel's own two opposite faces works fine, the
  // resolver doesn't require from/to to be different nodes.
  const depthMatchesLeft = () => [{
    field: 'height', type: 'spansBetween', overridden: false,
    from: { node: left.id, face: 'right', offset: 0 },
    to: { node: left.id, face: 'left', offset: 0 },
    id: nextId(),
  }];

  const top = createPanelNode({
    name: 'Top',
    width: W, height: D, thickness: T, material, rotation: { x: 90, y: 0, z: 0 },
    isBoxPanel: true, 
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.topBottom.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.topBottom.lockedResizeAxes,
    lockedFields: {...BOX_GIZMO_LOCKS.topBottom.lockedFields},
    constraints: [
      ...outerWidthSpan(),
      ...depthMatchesLeft(),
    ],
  });
  const bottom = createPanelNode({
    name: 'Bottom',
    width: W, height: D, thickness: T, material, rotation: { x: 90, y: 0, z: 0 },
    isBoxPanel: true, 
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.topBottom.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.topBottom.lockedResizeAxes,
    lockedFields: {...BOX_GIZMO_LOCKS.topBottom.lockedFields},
    constraints: [
      ...outerWidthSpan(),
      ...depthMatchesLeft(),
    ],
  });
  const back = createPanelNode({
    name: 'Back',
    // Covers ALL FOUR outer edges of the assembly — full width
    // (spans left/right's outer faces, same as top/bottom) and full
    // height (spans top/bottom's own OUTER edges, so it also covers
    // the T-thick overhang top/bottom add above/below H) — like a
    // real cabinet's solid back sheet, nailed across the whole
    // carcass rather than let into it.
    width: W, height: H + 2 * T, thickness: T, material, rotation: { x: 0, y: 0, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: {...BOX_GIZMO_LOCKS.frontBack.lockedFields},
    constraints: [
      ...innerWidthSpan(),
      // height spans top's OUTER (upper) edge to bottom's OUTER
      // (lower) edge — 'back'/'front' here are top/bottom's own
      // thickness-axis faces (their topside/underside respectively).
      { field: 'height', type: 'spansBetween', overridden: false,
        from: { node: top.id, face: 'back', offset: -T },
        to: { node: bottom.id, face: 'front', offset: -T }, id: nextId() },
    ],
  });
  const front = createPanelNode({
    name: 'Front',
    // Inner-fitted, same footprint the original single-panel back
    // used to have — grooved between the sides rather than covering
    // them, unlike the new back above. Height still tracks H (via
    // left's own top/bottom faces) so it isn't left stale on resize.
    width: W - 2 * T, height: H, thickness: T, material, rotation: { x: 0, y: 0, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: {...BOX_GIZMO_LOCKS.frontBack.lockedFields},
    constraints: [
      ...innerWidthSpan(),
      { field: 'height', type: 'spansBetween', overridden: false,
        from: { node: top.id, face: 'top', offset: 0 },
        to: { node: bottom.id, face: 'bottom', offset: 0 }, id: nextId() },
    ],
  });

  const boxPanels = [left, right, top, bottom, back, front];
  boxPanels.forEach((p) => { p.groupId = left.id; p.isBoxPanel = true;p.isBoxWall = true}); // left's own id doubles as the group's identifier — no separate id generator needed

  // left/right are the sole literal panels, positioned via `offset`
  // alone — everything else derives from them (see the constraint
  // definitions above: top/bottom's width, depth, and Y-position, and
  // back/front's width, height, and Z-position, all trace back to
  // left/right — directly, or via top/bottom which themselves trace
  // back to left/right — never the reverse).
  //
  // All 6 box panels share ONE basePosition — the box's own single
  // far-right placement slot (treating its WxH front footprint like
  // one panel for that purpose) — rather than each independently
  // claiming its own row slot the way plain "add panel" does. `desired`
  // is each panel's position relative to that shared anchor (e.g.
  // left sits (W/2-T/2) to the anchor's left) — `offset` is set
  // directly to those LOCAL deltas, since basePosition already
  // carries the anchor's absolute placement; resolved position ends
  // up as basePosition + offset = anchor + local-delta, which is
  // exactly what's wanted. (An earlier version subtracted anchor from
  // `want` here too, which canceled the anchor out of the result
  // entirely — the box would always land near local/origin
  // coordinates no matter where the anchor said it should go.)

  const desired = new Map([
    [left.id, {
      x: -(W / 2 - T / 2),
      y: 0,
      z: 0,
    }],

    [right.id, {
      x: +(W / 2 - T / 2),
      y: 0,
      z: 0,
    }],

    [bottom.id, {
      x: 0,
      y: -H / 2 - T / 2,
      z: 0,
    }],

    [top.id, {
      x: 0,
      y: +H / 2 + T / 2,
      z: 0,
    }],

    [back.id, {
      x: 0,
      y: 0,
      z: -D / 2 - T / 2,
    }],

    [front.id, {
      x: 0,
      y: 0,
      z: +D / 2 + T / 2,
    }],
  ]);

  const anchor = computeNextBasePosition(resolveConstraints(panels), { width: W, height: H, thickness: T, rotation: { x: 0, y: 0, z: 0 } });

  anchor.y = H / 2 + T;

  boxPanels.forEach((p) => {
    p.basePosition = anchor;
    const want = desired.get(p.id);
    p.offset = want
      ? { x: want.x, y: want.y, z: want.z }
      : { x: 0, y: 0, z: 0 };
  });

  panels = [...panels, ...boxPanels]; // always appended — never replaces an existing panel
  setSelectedGroupId(left.id);
  setSelectedId(front.id); // land somewhere sensible rather than deselecting entirely
  removeSelected()
  setSelectedId(null);
  renderAll();
}

// Initial state: a full box (addBox() calls renderAll() itself at
// its end, so this alone replaces the old seed1/seed2 + renderAll()
// startup).
addBox();

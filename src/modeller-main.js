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
 *
 * STAGE 3: box walls (isBoxWall) no longer carry spansBetween/
 * attachedTo constraints at all. A fully cross-referential 6-panel
 * box (every wall's cross-axis fields derived from its neighbors)
 * is impossible through resolveConstraints — its cycle check is
 * per-NODE, not per-field, so "Left depends on Top for height; Top
 * depends on Left for width" gets flagged circular even though the
 * two fields don't actually conflict (this was tried and is a real,
 * tested dead end — see the old addBox() history). Box internals are
 * now plain arithmetic instead: see computeBoxLayout() in modules.js
 * and relayoutBox() below, which every box-wall drag/resize/material
 * change funnels through.
 */
import {
  createPanelNode,
  computeNextBasePosition,
  computeWorldHalfExtents,
  MM_TO_UNIT,
  MIN_PANEL_DIM_MM,
  FLOOR_MM,
  DESIGN_LIMITS_MM,
  PANEL_SIZE_LIMITS_MM,
  MATERIAL_CATALOG,
  loadMaterialCatalog,
  nextConstraintId,
  FACE_TO_DIM_FIELD,
  getAlignedAxis,
  LOCAL_FACES,
} from './modeller/modules.js';
import { resolveConstraints } from './modeller/snap.js';
import { createModellerScene } from './modeller/scene.js';
import { getSelectedId, setSelectedId, getSelectedGroupId, setSelectedGroupId } from './modeller/selection.js';
import { computeBom } from './engine/bom.js';
import { exportCutListPdf, exportNestingPdf } from './engine/pdfExport.js';
import { nestCutList, summarizeNestingResult } from './engine/nesting.js';
import { renderProperties } from './ui/properties.js';
import { renderPanelList } from './ui/toolbar.js';
import { renderRelations } from './ui/relations.js';
import { initResizableLayout } from './ui/layout.js';
import { addBox, relayoutBox} from './features/box.js';

// TO ADD THE FOLLOWING IMPORTS
import {isShelf} from './features/shelf.js'
import {startShelfMode, cancelShelfMode} from './tools/shelfTool.js'
import {startCollinearMode, cancelCollinearMode} from './tools/collinearTool.js'
import {clampOffsetToDesignLimits,
  clampGroupOffsetToDesignLimits,
  findPanelSizeViolation,
  findDesignLimitViolation,
  collectAxisSlabs} from './shared/geometry.js'
import {showToast, hideToast, showDesignLimitError, showPanelSizeLimitError} from './ui/toast.js'
import {openCutListWindow, openNestingPlan, renderNestingSummary, setBomRows} from './ui/cutlist.js'
import {openCutListWindow, openNestingPlan, renderNestingSummary} from './ui/cutlist.js'

import {
  history,createStateCommand,MovePanelCommand,MoveGroupCommand,ResizePanelCommand,ChangeMaterialCommand,
  ChangeGroupMaterialCommand,RenamePanelCommand,AddPanelCommand,DeletePanelCommand,AddBoxCommand,
  DeleteBoxCommand,GroupPanelsCommand,UngroupPanelsCommand,AddShelfCommand,DeleteShelfCommand,
  AddConstraintCommand,RemoveConstraintCommand,UnlinkConstraintCommand,HideBoxWallCommand,RestoreBoxWallCommand,
} from './history/history.js';
initResizableLayout();

// ---- THE GRAPH ----
// Initial state: one box, rather than two bare panels — see addBox()
// below and the addBox() call at the very end of this file (after
// every other module-level const/function this needs has been
// defined; addBox() itself calls renderAll(), so nothing else is
// needed here).
let panels = [];
let lastBomRows = []; // cached from the most recent renderAll(), so the export button reflects exactly what's on screen without recomputing
function capturePanelsState() {
  return panels;
}

function restorePanelsState(nextPanels) {
  panels = nextPanels;
  renderAll();
}

export function recordHistoryCommand(CommandClass, before, after) {
  const command = createStateCommand({
    CommandClass,
    before,
    after,
    applyState: restorePanelsState,
  });
  history.record(command);
}
// Cached from the most recent "Nest Cut List" run — kept around so
// the inline summary/warning banner survives ordinary re-renders
// without recomputing nesting on every renderAll() (real packing
// work, not a cheap aggregation like computeBom). `signature` is a
// lightweight fingerprint of the BOM rows nesting was actually run
// against, so a later design change can be flagged as "stale"
// without needing to re-nest just to notice.
let lastNestingResult = null; // { nestResults, summary, signature } | null









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
let moveDragBefore = null;
let moveDragIsGroup = false;

let designLimitHideTimer = null;









// ---- DOM refs ----
const canvas = document.getElementById('canvas');
const main = document.getElementById('main');
const panelListMountEl = document.getElementById('panel-list-mount');
const relationsMountEl = document.getElementById('relations-container');
const inspectorEl = document.getElementById('properties-container');
const bomBodyEl = document.getElementById('bom-body');
const stageLabelEl = document.getElementById('stage-label');
const axesCanvas = document.getElementById('axes-gizmo-canvas');
const pipCanvas = document.getElementById('pip-canvas');
const nestingSummaryEl = document.getElementById('nesting-summary');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');

function syncHistoryButtons() {
  if (undoBtn) undoBtn.disabled = !history.canUndo();
  if (redoBtn) redoBtn.disabled = !history.canRedo();
}
history.setOnChange(syncHistoryButtons);
undoBtn?.addEventListener('click', () => history.undo());
redoBtn?.addEventListener('click', () => history.redo());
syncHistoryButtons();

document.getElementById('export-bom-pdf-btn')?.addEventListener('click', () => {
  if (lastBomRows.length === 0) return;
  exportCutListPdf(lastBomRows, { projectName: 'Cut List' });
});

// ---- Scene (view layer). Consumes RESOLVED panels only. ----
const { reconcile, setViewMode, setFacePickMode, setFaceHighlight, setPanelHighlight } = createModellerScene(canvas, main, {
  axesCanvas,
  pipCanvas,
  onPipModeClick: (mode) => switchView(mode),
  onSelect: handleCanvasSelectClick,
  onTransformChange: (nodeId, transform) => {
    if (moveDragBefore === null) {
      moveDragBefore = panels;
      moveDragIsGroup = false;
    }

    const node = panels.find((p) => p.id === nodeId);
    if (!node) return;

    // -----------------------------------------------------------
    // BOX WALLS: bypass the ordinary single-node clamp entirely.
    // Moving one wall changes one of the box's three "sizes" (W/H/D)
    // and every other wall has to re-fit around it — see
    // relayoutBox() below. The whole box is validated as ONE unit;
    // if it fails, this wall's own drag is rejected and reverted too
    // (a partially-updated box is worse than no update at all).
    // -----------------------------------------------------------
    if (node.isBoxWall) {
      const priorOffset = node.offset;
      updateNode(nodeId, { offset: transform.offset, rotation: transform.rotation });

      const applied = relayoutBox(node.groupId);
      if (!applied) {
        updateNode(nodeId, { offset: priorOffset });
        renderAll();
        return {
          x: (node.basePosition.x + priorOffset.x) * MM_TO_UNIT,
          y: (node.basePosition.y + priorOffset.y) * MM_TO_UNIT,
          z: (node.basePosition.z + priorOffset.z) * MM_TO_UNIT,
        };
      }

      renderAll(); // the other 5 walls all just changed — full reconcile, not just this node
      return;
    }

    const { offset: clampedOffset, hitAxis } = clampOffsetToDesignLimits(node, transform.offset);

    if (isShelf(node)) {
      const axis = rotationsMatch(node.rotation, HORIZONTAL_ROTATION) ? 'y' : 'x';
      const spacing = checkMinGap(collectAxisSlabs(node.groupId, axis, {
        [node.id]: { center: clampedOffset[axis], halfThickness: node.thickness / 2, label: node.name || 'Shelf' },
      }));
      if (!spacing.ok) {
        showToast(`Can't fit — ${spacing.a} and ${spacing.b} would be closer than ${MIN_WALL_GAP_MM}mm`);
        return {
          x: (node.basePosition.x + node.offset.x) * MM_TO_UNIT,
          y: (node.basePosition.y + node.offset.y) * MM_TO_UNIT,
          z: (node.basePosition.z + node.offset.z) * MM_TO_UNIT,
        }; // reject — snap the mesh back to its pre-drag offset
      }
    }

    updateNode(nodeId, { offset: clampedOffset, rotation: transform.rotation });
    if (nodeId === getSelectedId()) { renderInspectorOnly(); }
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
    moveDragBefore = panels;
    moveDragIsGroup = true;
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

window.addEventListener('pointerup', () => {
  if (moveDragBefore === null) return;
  const before = moveDragBefore;
  const isGroup = moveDragIsGroup;
  moveDragBefore = null;
  moveDragIsGroup = false;
  const after = panels;
  if (before === after) return;
  recordHistoryCommand(isGroup ? MoveGroupCommand : MovePanelCommand, before, after);
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
  const before = panels;
  updateNode(nodeId, { width: dims.width, height: dims.height, thickness: dims.thickness, offset: proposedOffset });
  const after = panels;
  recordHistoryCommand(ResizePanelCommand,before,after);
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
//
// NOTE: this tool still attaches shelves to Left/Right/Top/Bottom via
// live constraints, unrelated to the box-WALL relayout above — a
// shelf isn't a box wall (isBoxWall is never set on it), so it goes
// through the ordinary resolveConstraints() path exactly as before.
// -------------------------------------------------------------

// A panel's ROTATION, not its name, is what makes it a valid boundary
// — this is what lets an existing shelf stand in for Left/Right/Top/
// Bottom. Left/Right and any "Shelf (V)" all share the same rotation
// as VERTICAL_ROTATION (declared further down, alongside
// createAndSelectPanel — safe to reference here since this is only
// ever read once these functions are actually CALLED, well after the
// whole module has finished loading); Top/Bottom and any "Shelf (H)"
// share HORIZONTAL_ROTATION.
const SHELF_BOUNDARY_ROTATION = { horizontal: () => VERTICAL_ROTATION, vertical: () => HORIZONTAL_ROTATION };



let shelfMode = null;
let shelfPick1 = null;
let shelfPick1ClickMm = null; // desired position along the shelf's free axis, from where the first pick was clicked — null if unavailable (e.g. 2D view), in which case addShelf falls back to auto-placement


























// Escape cancels an in-progress collinear pick, same as it already
// does for nothing else in this app (no other modal/multi-step tool
// exists yet) — scoped narrowly so it can't interfere with anything.
window.addEventListener('keydown', (e) => {
  const modifier = e.ctrlKey || e.metaKey;
  if (!modifier) return;

  if (e.key === 'Escape' && collinearActive) cancelCollinearMode();
  if (e.key === 'Escape' && shelfMode) cancelShelfMode();
  
  if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    history.undo();
    return;
  }

  if (e.key.toLowerCase() === 'z' && e.shiftKey ||e.key.toLowerCase() === 'y'){
    e.preventDefault();
    history.redo();
  }
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
export function updateNode(id, patch) {
  panels = panels.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

// -------------------------------------------------------------
// BOX RELAYOUT (Stage 3) — replaces the old spansBetween/attachedTo
// constraint web the box used to run its 6 walls through (see the
// file-header comment for why that approach hits a hard wall in
// resolveConstraints' per-node cycle check). Box walls carry NO
// constraints anymore: each keeps its own literal offset on its one
// free axis, and this function recomputes every OTHER field on all
// six of them, straight from computeBoxLayout() in modules.js.
//
// Called after any box-wall move, typed offset edit, or material
// (thickness) change — see the three call sites below. Validates the
// WHOLE resulting box (every wall's size + design-limit position)
// before committing anything; a single wall's edit can never leave
// the box in a partially-updated, visually broken state. Returns
// true if applied, false if rejected (a toast has already been shown
// either way).
// -------------------------------------------------------------










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
  const before = panels;
  panels = panels.map((p) => (ids.includes(p.id) ? { ...p, groupId: newGroupId } : p));
  const after = panels;
  recordHistoryCommand(GroupPanelsCommand,before,after);
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
  const before = panels;
  panels = panels.map((p) => (p.groupId === groupId ? { ...p, groupId: null, hidden: false } : p));
  const after = panels;
  recordHistoryCommand(UngroupPanelsCommand,before,after);
  setSelectedGroupId(null);
  setSelectedId(formerMembers[0] || null); // land somewhere sensible rather than deselecting entirely
  renderAll();
}

export function renderAll() {
  const selectedId = getSelectedId();
  const selectedGroupId = getSelectedGroupId();
  const selectedBoxWallId = selectedId && panels.find(p => p.id === selectedId)?.isBoxWall ? selectedId : null;
  const resolved = resolveConstraints(panels); // unfiltered — a hidden panel still needs to resolve correctly so any sibling constraint referencing it stays accurate, and so it's instantly right again the moment it's restored

  // pieceCode is assigned once, at creation, on the RAW node — same
  // reasoning as boxWallIds just below: resolveConstraints rebuilds
  // each node's fields and isn't guaranteed to carry an arbitrary
  // custom field through untouched, so this reads it back from
  // `panels` (authoritative) rather than trusting the resolved copy.
  const pieceCodeById = new Map(panels.map((p) => [p.id, p.pieceCode]));
  const resolvedWithCodes = resolved.map((r) => ({
    ...r,
    pieceCode: r.pieceCode ?? pieceCodeById.get(r.id),
  }));

  const visiblePanels = resolvedWithCodes.filter((p) => !p.hidden);
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

  reconcile(visiblePanels, selectedId, selectedGroupId, multiSelectedIds, boxWallIds, selectedBoxWallId);

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
    onOpenCutList: openCutListWindow,
    onNestCutList: openNestingPlan,
  });

  renderInspectorOnly();

  const rows = computeBom(visiblePanels);
  lastBomRows = rows;
  renderNestingSummary(); // re-check staleness against the freshly recomputed BOM rows, without re-nesting
  stageLabelEl.textContent = `${visiblePanels.length} node(s) · constraints active`;
}

function renderInspectorOnly() {
  const selectedId = getSelectedId();
  const selectedGroupId = getSelectedGroupId();

  const selectedPanel =
    panels.find((p) => p.id === selectedId) || null;

  // Recomputed here too (not threaded from renderAll) so the
  // high-frequency onTransformChange path always reflects
  // the current state of every field, not a stale snapshot.
  const resolved =
    resolveConstraints(panels);

  const resolvedPanel =
    resolved.find((r) => r.id === selectedId) || null;

  const groupMembers =
    selectedGroupId
      ? panels.filter(
          (p) => p.groupId === selectedGroupId
        )
      : [];

  const visibleGroupMembers =
    groupMembers.filter(
      (p) => !p.hidden
    );

  const hiddenGroupMembers =
    groupMembers.filter(
      (p) => p.hidden
    );

  const groupMemberCount =
    visibleGroupMembers.length;

  // null means "Mixed materials".
  const groupMaterial =
    groupMembers.length > 0 &&
    groupMembers.every(
      (p) =>
        p.material === groupMembers[0].material
    )
      ? groupMembers[0].material
      : null;


  /* =========================================================
     PROPERTIES
     ========================================================= */

  if (inspectorEl) {
    renderProperties(
      inspectorEl,
      {
        selectedPanel,
        resolvedPanel,
        selectedGroupId,
        groupMemberCount,
        groupMaterial,
        hiddenGroupMembers,

        onFieldChange:
          updateSelectedField,

        onTransformFieldChange:
          updateSelectedTransformField,

        onUnlinkConstraint:
          unlinkOrRemoveConstraint,

        onRename:
          renameSelected,

        onRemove:
          removeSelected,

        onUngroup:
          ungroupSelected,

        onRestoreFace:
          restoreFace,

        onGroupMaterialChange:
          updateGroupMaterial,
      }
    );
  }


  /* =========================================================
     RELATIONS
     ========================================================= */

  if (relationsMountEl) {
    renderRelations(
      relationsMountEl,
      {
        selectedPanel,
        allPanels: panels,
        onUnlinkConstraint:
          unlinkOrRemoveConstraint,
      }
    );
  }
}

function renameSelected(newName) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  const trimmed = newName.trim();
  const nextName = trimmed === '' ? null : trimmed;
  if (node.name === nextName) return;

  const before = panels;
  updateNode(selectedId, {name: nextName,});
  const after = panels;
  recordHistoryCommand(RenamePanelCommand,before,after);
  renderAll();
}

function updateSelectedField(field, value) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  // A box wall's width/height are derived by relayoutBox() now, not
  // user-editable directly — the only way to change them is to drag
  // the wall itself (changes the offset) or change its material
  // (changes thickness, handled in the 'material' branch below).
  if (node.isBoxWall && (field === 'width' || field === 'height')) {
    return;
  }

  if (field === 'material') {
    // The ONLY way thickness is allowed to change after a panel is
    // created — selecting a different material carries its own fixed
    // thickness with it (MATERIAL_CATALOG in modules.js). There's no
    // separate typed thickness field anywhere in the inspector.
    const catalogEntry = MATERIAL_CATALOG.find((m) => m.name === value);
    if (!catalogEntry) return; // dropdown only ever offers catalog entries — defensive, shouldn't happen

    if (node.isBoxWall) {
      // Thickness feeds directly into computeBoxLayout()'s inner/
      // outer face math for every wall, not just this one — so a
      // material swap here has to go through the same whole-box
      // validate-then-commit path as a drag, not the single-node
      // design-limit check below.
      const before = panels;
      updateNode(selectedId, {material: catalogEntry.name,thickness: catalogEntry.thicknessMm});
      const applied = relayoutBox(node.groupId);

      if (!applied) {
        panels = before;
        renderAll();
        return;
      }
      const after = panels;
      recordHistoryCommand(ChangeMaterialCommand,before,after);
      renderAll();
    return;
    }

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
    const before = panels;
    updateNode(selectedId, { material: catalogEntry.name, thickness: catalogEntry.thicknessMm });
    const after = panels;
    recordHistoryCommand(ChangeMaterialCommand,before,after);
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

  // Box groups: every member's thickness feeds computeBoxLayout(), so
  // a whole-group material swap has to be validated as ONE relayout,

  // not per-member — a change that's fine for Left in isolation could
  // still push Top/Bottom/Back/Front out of bounds once every wall's
  // thickness moves together.
  if (members.some((p) => p.isBoxWall)) {
    const before = panels;
    const priorMaterials = new Map(members.map((p) => [p.id, { material: p.material, thickness: p.thickness }]));
    panels = panels.map((p) =>
      p.groupId === groupId ? { ...p, material: catalogEntry.name, thickness: catalogEntry.thicknessMm } : p
    );
    const applied = relayoutBox(groupId);
    if (!applied) {
      panels = panels.map((p) => {
        const prior = priorMaterials.get(p.id);
        return prior ? { ...p, material: prior.material, thickness: prior.thickness } : p;
      });
    renderAll();
    return;
    }
    const after = panels;
    recordHistoryCommand(ChangeGroupMaterialCommand,before,after);
    return;
  }

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

  const before = panels;
  panels = panels.map((p) =>
    p.groupId === groupId ? { ...p, material: catalogEntry.name, thickness: catalogEntry.thicknessMm } : p
  );
  const after = panels;
  recordHistoryCommand(ChangeGroupMaterialCommand,before,after)
  renderAll();
}

function updateSelectedTransformField(group, axis, value) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  // Box walls: a typed offset edit is exactly the same kind of change
  // as a drag on that same axis (the other two axes are locked
  // out already, via lockedFields/lockedMoveAxes upstream in the
  // inspector) — route it through relayoutBox rather than the plain
  // single-node clamp below, so the rest of the box re-fits too.
  if (node.isBoxWall && group === 'offset') {
    const before = panels;
    updateNode(selectedId, {offset: {...node.offset,[axis]: value,},});
    const applied = relayoutBox(node.groupId);

    if (!applied) {
      panels = before;
      renderAll();
      return;
    }

    const after = panels;
    recordHistoryCommand(MovePanelCommand,before,after);
    renderAll();
    return;
  }

  if (group === 'offset') {
    const proposedOffset = { ...node.offset, [axis]: value };
    const { hitAxis } = clampOffsetToDesignLimits(node, proposedOffset);
    if (hitAxis) {
      showDesignLimitError(hitAxis);
      renderAll(); // revert the inspector's input back to the stored (unchanged) value
      return;
    }
  }
  const before = panels;
  updateNode(selectedId, { [group]: { ...node[group], [axis]: value } });
  const after = panels;
  recordHistoryCommand(MovePanelCommand,before,after);
  renderAll();
}


function createAndSelectPanel(rotation) {
  const before = capturePanelsState(); // to aliment history (undo/redo) before the new panel is added

  const node = createPanelNode({ rotation });
  node.basePosition = computeNextBasePosition(resolveConstraints(panels), node);
  panels = [...panels, node];

  const after = capturePanelsState(); // to aliment history (undo/redo) after the new panel is added
  recordHistoryCommand(AddPanelCommand,before,after);
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
    // group-level selection (nothing drilled into) — permanent delete
    // of the whole group, unchanged.
    const before = panels;
    panels = panels.filter((p) => p.groupId !== groupId);
    const after = panels;
    setSelectedGroupId(null);
    setSelectedId(panels.length > 0 ? panels[0].id : null);
    recordHistoryCommand(DeleteBoxCommand,before,after);
    renderAll();
    return;
  }

  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  if (node.groupId && isShelf(node)) {
    // Shelves have no "restore" concept — a shelf's position is a
    // user choice, not part of the box's structure, so removing one
    // erases it from the graph completely and immediately frees the
    // space it occupied (collectAxisSlabs never has to know about a
    // gone-but-still-blocking shelf, because there's no such state).
    const before = panels;
    panels = panels.filter((p) => p.id !== selectedId);
    const after = panels;
    setSelectedGroupId(node.groupId);
    setSelectedId(null);
    recordHistoryCommand(DeleteShelfCommand,before,after);
    renderAll();
    return;
  }

  if (node.groupId) {
    // panel-level selection WITHIN a group — a box WALL face. HIDE it
    // rather than removing it from the graph (restorable via the
    // group inspector) — unchanged from before.
    const before = panels;
    panels = panels.map((p) => (p.id === selectedId ? { ...p, hidden: true } : p));
    const after = panels;
    setSelectedGroupId(node.groupId);
    setSelectedId(null);
    recordHistoryCommand(HideBoxWallCommand,before,after);
    renderAll();
    return;
  }

  // plain standalone panel — permanent removal, unchanged.
  const before = panels;
  panels = panels.filter((p) => p.id !== selectedId);
  const after = panels;
  setSelectedId(panels.length > 0 ? panels[0].id : null);
  recordHistoryCommand(DeletePanelCommand,before,after);
  renderAll();
}

function restoreFace(nodeId) {
  const node = panels.find((p) => p.id === nodeId);
  if (!node || !node.hidden) return;

  const before = panels;
  panels = panels.map((p) => (p.id === nodeId ? { ...p, hidden: false } : p));
  const after = panels;
  recordHistoryCommand(RestoreBoxWallCommand,before,after);
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
// one by hand. Box walls never have entries here (they carry no
// constraints — see relayoutBox above), so this never has to
// special-case isBoxWall.
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
    const before = panels;
    const nextConstraints = (node.constraints || []).filter((c) => c.id !== identifier);
    updateNode(selectedId, { constraints: nextConstraints });
    const after = panels;
    recordHistoryCommand(RemoveConstraintCommand, before, after);
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
  const before = panels;
  updateNode(selectedId, patch);
  const after = panels;
  recordHistoryCommand(UnlinkConstraintCommand,before,after);
  renderAll();
}

/**
 * Box preset: replaces the selected panel with 6 real panel nodes —
 * left, right, top, bottom, back, front — forming an open-front box.
 *
 * STAGE 3 REWRITE: top/bottom/back/front's width/height/position used
 * to be governed by spansBetween/attachedTo constraints resolved by
 * snap.js. That's gone now — see relayoutBox() above and
 * computeBoxLayout() in modules.js. Every wall is created as a plain
 * literal panel (constraints: [] via createPanelNode's own default),
 * with a starting width/height/offset that's already numerically
 * correct for the requested W/H/D — and then relayoutBox() is called
 * once immediately after, purely to run every field through the
 * exact same math a later drag will use, so the box starts out
 * indistinguishable from "just been dragged into this shape".
 */

// const DEFAULT_BOX_DEPTH_MM = 400;
// const DEFAULT_BOX_WIDTH_MM = 500;
// const DEFAULT_BOX_HEIGHT_MM = 700;

// const BOX_GIZMO_LOCKS = {
//   leftRight: {
//     lockedMoveAxes: ['y', 'z'],
//     lockedResizeAxes: ['x', 'y', 'z'],
//     lockedFields: {
//       positionY: true,
//       positionZ: true,
//     },
//   },

//   topBottom: {
//     lockedMoveAxes: ['x', 'z'],
//     lockedResizeAxes: ['x', 'y', 'z'],
//     lockedFields: {
//       positionX: true,
//       positionZ: true,
//     },
//   },

//   frontBack: {
//     lockedMoveAxes: ['x', 'y'],
//     lockedResizeAxes: ['x', 'y', 'z'],
//     lockedFields: {
//       positionX: true,
//       positionY: true,
//     },
//   },
// };

function isBoxWall(mesh) {
  return mesh?.userData?.isBoxWall === true;
}

async function bootstrap() {
  await loadMaterialCatalog();
  addBox();
  history.clear();
}
bootstrap();
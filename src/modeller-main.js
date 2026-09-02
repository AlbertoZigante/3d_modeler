/**
 * Entry point for the modeller page. This is the only file that is
 * allowed to mutate `panels` — every module it imports only reads
 * data or fires callbacks back up here (including features/box.js,
 * features/shelf.js, and every tools/*.js file, all of which are
 * pure and return data rather than touching the graph directly). That
 * single-writer rule is what keeps "graph -> view" one-directional.
 *
 * STAGE 2: `renderAll()` runs `resolveConstraints(panels)` once per
 * render — this is THE seam where raw graph (literals + constraints)
 * becomes resolved graph (concrete numbers everywhere). scene.reconcile(),
 * computeBom(), and renderPanelList() all consume the RESOLVED array;
 * only renderProperties() sees the raw node too, since the inspector
 * is the one place that needs to know a constraint exists at all (to
 * render it locked, and to offer "Unlink").
 *
 * STAGE 3: box walls (isBoxWall) carry no spansBetween/attachedTo
 * constraints at all — a fully cross-referential 6-panel box is
 * impossible through resolveConstraints' per-node cycle check (see
 * features/box.js's own header for why). Box internals are plain
 * arithmetic instead: computeBoxLayout() and relayoutBox() live in
 * features/box.js, which every box-wall drag/resize/material change
 * funnels through — see applyRelayoutResult() below.
 *
 * STAGE 4 (this file): box creation, shelf creation, and every
 * pick-mode tool (shelf, collinear, attach) moved out into
 * features/*.js and tools/*.js as pure modules. This file no longer
 * implements any of them — it owns application state, orchestrates
 * commits, and wires each tool to the live app via a small context
 * object (see toolContext below) since they need a few runtime
 * handles (the live panels array, the scene's pick-mode hooks) that
 * don't exist as static module exports anywhere.
 */
import {
  createPanelNode,
  computeNextBasePosition,
  MM_TO_UNIT,
  MATERIAL_CATALOG,
  loadMaterialCatalog,
  getDisplayName,
} from './modeller/modules.js';
import { resolveConstraints } from './modeller/snap.js';
import { createModellerScene } from './modeller/scene.js';
import { getSelectedId, setSelectedId, getSelectedGroupId, setSelectedGroupId } from './modeller/selection.js';
import { computeBom } from './engine/bom.js';
import { exportCutListPdf } from './engine/pdfExport.js';
import { renderProperties } from './ui/properties.js';
import { renderPanelList } from './ui/toolbar.js';
import { renderRelations } from './ui/relations.js';
import { initResizableLayout } from './ui/layout.js';
import { showToast, showDesignLimitError, showPanelSizeLimitError } from './ui/toast.js';
import { openCutListWindow, openNestingPlan, renderNestingSummary, setBomRows, getLastBomRows } from './ui/cutlist.js';
import {
  clampOffsetToDesignLimits,
  clampGroupOffsetToDesignLimits,
  findPanelSizeViolation,
  findDesignLimitViolation,
  collectAxisSlabs,
  checkMinGap,
  rotationsMatch,
  VERTICAL_ROTATION,
  HORIZONTAL_ROTATION,
  PARALLEL_ROTATION,
  MIN_WALL_GAP_MM,
} from './shared/geometry.js';
import { addBox, relayoutBox } from './features/box.js';
import { isShelf } from './features/shelf.js';
import { createDoorNode, computeDoorOpenTransform, applyDoorAdjustmentsForGroup, applyPanelPatch } from './features/door.js';
import { startShelfMode, cancelShelfMode, getShelfMode, setShelfToolContext } from './tools/shelfTool.js';
import { setBoundaryRectToolContext } from './tools/boundaryRectTool.js';
import {
  startDoorMode,
  cancelDoorMode,
  confirmDoorMode,
  setDoorEdgeFitField,
  setDoorHinge,
  isDoorPickActive,
  isDoorConfirmActive,
  getDoorEdgeFit,
  getDoorHinge,
  setDoorToolContext,
} from './tools/doorTool.js';
import {
  startCollinearMode,
  cancelCollinearMode,
  isCollinearActive,
  getCollinearGapMm,
  setCollinearGapMm,
  setCollinearToolContext,
} from './tools/collinearTool.js';
import { setAttachToolContext } from './tools/attachTool.js';
import {
  history, createStateCommand, MovePanelCommand, MoveGroupCommand, ResizePanelCommand, ChangeMaterialCommand,
  ChangeGroupMaterialCommand, RenamePanelCommand, AddPanelCommand, DeletePanelCommand, AddBoxCommand,
  DeleteBoxCommand, GroupPanelsCommand, UngroupPanelsCommand, DeleteShelfCommand,
  RemoveConstraintCommand, UnlinkConstraintCommand, HideBoxWallCommand, RestoreBoxWallCommand,
  ChangeEdgeFitCommand, AddDoorCommand, SetDoorHingeCommand, DeleteDoorCommand,
} from './history/history.js';
initResizableLayout();

// ---- THE GRAPH ----
// Initial state: one box — see handleAddBox() below and the
// handleAddBox() call inside bootstrap() at the very end of this
// file (after every other module-level const/function this needs has
// been defined).
let panels = [];

function capturePanelsState() {
  return panels;
}

function restorePanelsState(nextPanels) {
  panels = nextPanels;
  renderAll();
}

function recordHistoryCommand(CommandClass, before, after) {
  const command = createStateCommand({
    CommandClass,
    before,
    after,
    applyState: restorePanelsState,
  });
  history.record(command);
}

// Shared commit path for every feature that ADDS new nodes to the
// graph (box, shelf, and any future drawer/door/plinth) — appends,
// records ONE history command covering the addition. Passed into
// tools via toolContext below so shelfTool.js/attachTool.js don't
// need their own copy of this, and used directly here for
// handleAddBox().
function commitAddedNodes(nodes, CommandClass) {
  const before = panels;
  panels = [...panels, ...nodes];
  const after = panels;
  recordHistoryCommand(CommandClass, before, after);
}

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

// ---- DOM refs ----
const canvas = document.getElementById('canvas');
const main = document.getElementById('main');
const panelListMountEl = document.getElementById('panel-list-mount');
const relationsMountEl = document.getElementById('relations-container');
const inspectorEl = document.getElementById('properties-container');
const stageLabelEl = document.getElementById('stage-label');
const axesCanvas = document.getElementById('axes-gizmo-canvas');
const pipCanvas = document.getElementById('pip-canvas');
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
  const rows = getLastBomRows();
  if (rows.length === 0) return;
  exportCutListPdf(rows, { projectName: 'Cut List' });
});

// ---- Scene (view layer). Consumes RESOLVED panels only. ----
const { reconcile, setViewMode, setFacePickMode, setFaceHighlight, setPanelHighlight, setPanelHighlightSet } = createModellerScene(canvas, main, {
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
    // relayoutBox() in features/box.js. The whole box is validated
    // as ONE unit; if it fails, this wall's own drag is rejected and
    // reverted too (a partially-updated box is worse than no update
    // at all).
    // -----------------------------------------------------------
    if (node.isBoxWall) {
      const priorOffset = node.offset;
      updateNode(nodeId, { offset: transform.offset, rotation: transform.rotation });

      const result = relayoutBox(panels, node.groupId);
      if (!applyRelayoutResult(result)) {
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
      const spacing = checkMinGap(collectAxisSlabs(panels, node.groupId, axis, {
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
// collinearTool.js's applyCollinear (via toolContext.updateNode +
// findPanelSizeViolation/findDesignLimitViolation imported directly
// there) — validates a proposed width/height/thickness + offset delta
// against both per-panel size caps and the overall scene bounds, and
// only then commits it. Returns true if applied, false if rejected (a
// toast has already been shown either way it's rejected).
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
  recordHistoryCommand(ResizePanelCommand, before, after);
  renderAll();
  return true;
}

// -------------------------------------------------------------
// TOOL WIRING — shelfTool.js, collinearTool.js, and attachTool.js are
// pure interaction-state modules; none of them can reach `panels`,
// `renderAll`, or the scene's pick-mode hooks directly (they're not
// static exports anywhere — panels is module state here, and the
// scene handles above only exist once createModellerScene() has run).
// This context object is the one bridge between them and the live
// app, set once at startup.
// -------------------------------------------------------------
const toolContext = {
  getPanels: () => panels,
  updateNode,
  commitAddedNodes,
  recordHistoryCommand,
  renderAll: () => renderAll(),
  clearMultiSelected: () => multiSelectedIds.clear(),
  setFaceHighlight,
  setFacePickMode,
  setPanelHighlight,
  setPanelHighlightSet,
};
setShelfToolContext(toolContext);
setCollinearToolContext(toolContext);
setAttachToolContext(toolContext);
setBoundaryRectToolContext(toolContext);
setDoorToolContext({ getPanels: () => panels, renderAll: () => renderAll() });

// The 4 boundary panels adapt to the confirmed door exactly the way
// features/box.js's Left/Right/Top/Bottom already adapt to Front's/
// Back's edgeFit — computeDoorPlacement() (called by doorTool.js) is
// the pure math for both the new door node and each boundary panel's
// new dimension/offset; this is just the single write + one history
// entry, same shape every other feature's commit already follows.
function handleDoorConfirmed(placement) {
  const before = panels;

  placement.panelPatches.forEach((patch) => {
    panels = applyPanelPatch(panels, patch, placement.normalAxis);
  });

  const doorNode = createDoorNode(panels, placement);
  panels = [...panels, doorNode];

  const after = panels;
  recordHistoryCommand(AddDoorCommand, before, after);
  setSelectedId(doorNode.id);
  renderAll();
}

function confirmSelectedDoor() {
  const catalogEntry = MATERIAL_CATALOG[0];
  confirmDoorMode({ material: catalogEntry?.name, thicknessMm: catalogEntry?.thicknessMm ?? 18 }, handleDoorConfirmed);
}

// Maps a relayoutBox() result (see features/box.js) to the exact same
// user-facing toast text the old inline version showed, and applies
// the returned patches on success. Used at every box-wall
// move/resize/material call site below so that behavior — and
// wording — stays identical across all four.
function applyRelayoutResult(result) {
  if (!result.ok) {
    if (result.hitAxis) {
      showDesignLimitError(result.hitAxis);
    } else if (result.reason === 'min-dim') {
      showToast("Can't shrink the box that far — walls would overlap");
    } else if (result.reason?.startsWith('panel-size:')) {
      showPanelSizeLimitError(result.reason.split(':')[1]);
    } else if (result.reason?.startsWith('min-gap:')) {
      const [a, b] = result.reason.slice('min-gap:'.length).split('/');
      showToast(`Can't fit — ${a} and ${b} would be closer than ${MIN_WALL_GAP_MM}mm`);
    }
    return false;
  }
  result.patches.forEach((p) => updateNode(p.id, { width: p.width, height: p.height, offset: p.offset }));

  // relayoutBox just unconditionally recomputed all 6 box walls from
  // scratch (see its own comment) — it has no idea a door previously
  // required some of them to be shorter. Re-apply every door in this
  // same group now, against the walls' brand-new geometry, so a door
  // never has to be manually re-fixed after any other box edit — see
  // features/door.js#applyDoorAdjustmentsForGroup's own doc comment.
  const groupId = panels.find((p) => p.id === result.patches[0]?.id)?.groupId;
  if (groupId) {
    panels = applyDoorAdjustmentsForGroup(panels, groupId);
  }
  return true;
}

// Escape cancels an in-progress collinear or shelf pick — same as it
// already does for nothing else in this app (no other modal/
// multi-step tool exists yet) — scoped narrowly so it can't interfere
// with anything. Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (or +Y) drive undo/redo.
window.addEventListener('keydown', (e) => {
  const modifier = e.ctrlKey || e.metaKey;
  if (!modifier) return;

  if (e.key === 'Escape' && isCollinearActive()) cancelCollinearMode();
  if (e.key === 'Escape' && getShelfMode()) cancelShelfMode();
  if (e.key === 'Escape' && (isDoorPickActive() || isDoorConfirmActive())) cancelDoorMode();

  if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    history.undo();
    return;
  }

  if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
    e.preventDefault();
    history.redo();
  }
});

// -------------------------------------------------------------
// 3D / 2D view mode toggle. Purely a rendering/interaction switch —
// nothing about the graph, resolver, BOM, or inspector changes based
// on which view is active.
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
// Single generic graph-mutation primitive — every function below
// patches `panels` through this one function instead of each
// hand-rolling its own `.map(...)`. Also handed to tools via
// toolContext.updateNode above, so the single-writer rule holds even
// for edits that originate in shelfTool.js/collinearTool.js/
// attachTool.js — this function is still the only place `panels`
// actually changes.
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
  const before = panels;
  panels = panels.map((p) => (ids.includes(p.id) ? { ...p, groupId: newGroupId } : p));
  const after = panels;
  recordHistoryCommand(GroupPanelsCommand, before, after);
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
  recordHistoryCommand(UngroupPanelsCommand, before, after);
  setSelectedGroupId(null);
  setSelectedId(formerMembers[0] || null); // land somewhere sensible rather than deselecting entirely
  renderAll();
}

function renderAll() {
  const selectedId = getSelectedId();
  const selectedGroupId = getSelectedGroupId();
  const selectedBoxWallId = selectedId && panels.find((p) => p.id === selectedId)?.isBoxWall ? selectedId : null;
  const resolved = resolveConstraints(panels); // unfiltered — a hidden panel still needs to resolve correctly so any sibling constraint referencing it stays accurate, and so it's instantly right again the moment it's restored

  // pieceCode is assigned once, at creation, on the RAW node — same
  // reasoning as boxWallIds just below: resolveConstraints rebuilds
  // each node's fields and isn't guaranteed to carry an arbitrary
  // custom field through untouched, so this reads it back from
  // `panels` (authoritative) rather than trusting the resolved copy.
  const pieceCodeById = new Map(panels.map((p) => [p.id, p.pieceCode]));
  // Same reasoning, for a door's own hinge/open-state/normal-axis
  // fields — the 3D scene needs these (see sceneVisiblePanels below)
  // but resolveConstraints has no reason to know about them.
  const doorFieldsById = new Map(
    panels.filter((p) => p.isDoor).map((p) => [p.id, { isDoor: true, hinge: p.hinge, doorOpen: !!p.doorOpen, normalAxis: p.normalAxis, doorSign: p.doorSign }])
  );
  const resolvedWithCodes = resolved.map((r) => ({
    ...r,
    pieceCode: r.pieceCode ?? pieceCodeById.get(r.id),
    ...doorFieldsById.get(r.id),
  }));

  const visiblePanels = resolvedWithCodes.filter((p) => !p.hidden);
  // Authoritative "is this a box wall" id set, sourced directly from
  // the raw graph (`panels`), NOT from the resolved output. Every box
  // wall is stamped isBoxWall:true exactly once, in features/box.js's
  // addBox(), and never touched again — so `panels` is always right
  // here. The RESOLVED node isn't a safe place to read this flag
  // from: resolveConstraints rebuilds each constrained node's fields
  // and isn't guaranteed to carry every custom flag through untouched.
  const boxWallIds = new Set(panels.filter((p) => p.isBoxWall).map((p) => p.id));

  // The 3D view's OWN copy — a door with doorOpen:true renders swung
  // open (features/door.js#computeDoorOpenTransform). Deliberately a
  // SEPARATE array from `visiblePanels`: BOM/cut-list (below) and the
  // panel list both keep reading `visiblePanels` itself, which stays
  // at the door's real CLOSED position/rotation — doorOpen is a purely
  // visual toggle (see toggleSelectedDoorOpen), not a design change,
  // and must never affect what gets measured or cut.
  const sceneVisiblePanels = visiblePanels.map((p) => {
    if (!p.isDoor || !p.doorOpen) return p;
    const open = computeDoorOpenTransform(p);
    return open ? { ...p, position: open.position, rotation: open.rotation } : p;
  });

  reconcile(sceneVisiblePanels, selectedId, selectedGroupId, multiSelectedIds, boxWallIds, selectedBoxWallId);

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
    onAddBox: handleAddBox,
    onCollinear: () => (isCollinearActive() ? cancelCollinearMode() : (cancelShelfMode(), cancelDoorMode(), startCollinearMode())),
    collinearActive: isCollinearActive(),
    collinearGapMm: getCollinearGapMm(),
    onCollinearGapChange: setCollinearGapMm, // deliberately no renderAll() here — see toolbar.js's own comment on why
    onShelfHorizontal: () => (getShelfMode() === 'horizontal' ? cancelShelfMode() : (cancelCollinearMode(), cancelDoorMode(), startShelfMode('horizontal'))),
    onShelfVertical: () => (getShelfMode() === 'vertical' ? cancelShelfMode() : (cancelCollinearMode(), cancelDoorMode(), startShelfMode('vertical'))),
    shelfMode: getShelfMode(),
    onAddDoor: () => ((isDoorPickActive() || isDoorConfirmActive()) ? cancelDoorMode() : (cancelCollinearMode(), cancelShelfMode(), startDoorMode())),
    doorToolActive: isDoorPickActive() || isDoorConfirmActive(),
    doorConfirmActive: isDoorConfirmActive(),
    doorEdgeFit: getDoorEdgeFit(),
    onDoorEdgeFitChange: setDoorEdgeFitField,
    doorHinge: getDoorHinge(),
    onDoorHingeSelect: setDoorHinge,
    onDoorConfirm: confirmSelectedDoor,
    onDoorCancel: cancelDoorMode,
    onOpenCutList: openCutListWindow,
    onNestCutList: openNestingPlan,
  });

  renderInspectorOnly();

  const rows = computeBom(visiblePanels);
  setBomRows(rows);
  renderNestingSummary(); // re-check staleness against the freshly recomputed BOM rows, without re-nesting
  stageLabelEl.textContent = `${visiblePanels.length} node(s) · constraints active`;
}

function renderInspectorOnly() {
  const selectedId = getSelectedId();
  const selectedGroupId = getSelectedGroupId();

  const selectedPanel = panels.find((p) => p.id === selectedId) || null;

  // Recomputed here too (not threaded from renderAll) so the
  // high-frequency onTransformChange path always reflects the current
  // state of every field, not a stale snapshot.
  const resolved = resolveConstraints(panels);
  const resolvedPanel = resolved.find((r) => r.id === selectedId) || null;

  const groupMembers = selectedGroupId ? panels.filter((p) => p.groupId === selectedGroupId) : [];
  const visibleGroupMembers = groupMembers.filter((p) => !p.hidden);
  // Restorable = a hidden BOX WALL only — never a door or shelf.
  // Shelves are never hidden at all (removing one deletes it outright
  // — see removeSelected), and doors must not be either (same
  // function, same reasoning: a door that lingered as hidden-not-
  // deleted would sit here looking "restorable" while also
  // permanently blocking Left/Right/Top/Bottom/Back/Front's own real
  // restore via restoreFace's door check). isBoxWall is the exact
  // same authoritative flag renderAll() already trusts over anything
  // resolveConstraints might produce — see that call site's comment.
  const hiddenGroupMembers = groupMembers.filter((p) => p.hidden && p.isBoxWall);
  const groupMemberCount = visibleGroupMembers.length;

  // null means "Mixed materials".
  const groupMaterial =
    groupMembers.length > 0 && groupMembers.every((p) => p.material === groupMembers[0].material)
      ? groupMembers[0].material
      : null;

  if (inspectorEl) {
    renderProperties(inspectorEl, {
      selectedPanel,
      resolvedPanel,
      selectedGroupId,
      groupMemberCount,
      groupMaterial,
      hiddenGroupMembers,
      restoreError: restoreBlockedMessage,
      onFieldChange: updateSelectedField,
      onTransformFieldChange: updateSelectedTransformField,
      onUnlinkConstraint: unlinkOrRemoveConstraint,
      onRename: renameSelected,
      onRemove: removeSelected,
      onUngroup: ungroupSelected,
      onRestoreFace: restoreFace,
      onGroupMaterialChange: updateGroupMaterial,
      onEdgeFitChange: updateSelectedEdgeFit,
      onToggleDoorOpen: toggleSelectedDoorOpen,
      onDoorHingeChange: updateSelectedDoorHinge,
    });
  }

  if (relationsMountEl) {
    renderRelations(relationsMountEl, {
      selectedPanel,
      allPanels: panels,
      onUnlinkConstraint: unlinkOrRemoveConstraint,
    });
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
  updateNode(selectedId, { name: nextName });
  const after = panels;
  recordHistoryCommand(RenamePanelCommand, before, after);
  renderAll();
}

// Only ever called for a box's Front or Back wall (that's the only
// case ui/properties.js shows the Edge Fit control for — see its
// `node.edgeFit != null` check) — routes through relayoutBox exactly
// like the material-swap branch of updateSelectedField below does,
// because edgeFit feeds into computeBoxLayout()'s own per-wall math
// (see features/box.js#resolvePanelFit) the same way thickness does.
// Left/Right/Top/Bottom/the box's own outer footprint are untouched —
// only the one edited wall's width/height/offset can change.
function updateSelectedEdgeFit(edgeFit) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node || !node.groupId || !node.edgeFit) return; // defensive — the control only renders for a node that already has one

  const before = panels;
  updateNode(selectedId, { edgeFit });
  const result = relayoutBox(panels, node.groupId);

  if (!applyRelayoutResult(result)) {
    panels = before;
    renderAll();
    return;
  }
  const after = panels;
  recordHistoryCommand(ChangeEdgeFitCommand, before, after);
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
      updateNode(selectedId, { material: catalogEntry.name, thickness: catalogEntry.thicknessMm });
      const result = relayoutBox(panels, node.groupId);

      if (!applyRelayoutResult(result)) {
        panels = before;
        renderAll();
        return;
      }
      const after = panels;
      recordHistoryCommand(ChangeMaterialCommand, before, after);
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
    recordHistoryCommand(ChangeMaterialCommand, before, after);
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
    const result = relayoutBox(panels, groupId);
    if (!applyRelayoutResult(result)) {
      panels = panels.map((p) => {
        const prior = priorMaterials.get(p.id);
        return prior ? { ...p, material: prior.material, thickness: prior.thickness } : p;
      });
      renderAll();
      return;
    }
    const after = panels;
    recordHistoryCommand(ChangeGroupMaterialCommand, before, after);
    renderAll(); // NOTE: the original inline version of this branch never called renderAll() on success — fixed here, since every other commit path in this file does.
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
  recordHistoryCommand(ChangeGroupMaterialCommand, before, after);
  renderAll();
}

function updateSelectedTransformField(group, axis, value) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  // Box walls: a typed offset edit is exactly the same kind of change
  // as a drag on that same axis (the other two axes are locked out
  // already, via lockedFields/lockedMoveAxes upstream in the
  // inspector) — route it through relayoutBox rather than the plain
  // single-node clamp below, so the rest of the box re-fits too.
  if (node.isBoxWall && group === 'offset') {
    const before = panels;
    updateNode(selectedId, { offset: { ...node.offset, [axis]: value } });
    const result = relayoutBox(panels, node.groupId);

    if (!applyRelayoutResult(result)) {
      panels = before;
      renderAll();
      return;
    }

    const after = panels;
    recordHistoryCommand(MovePanelCommand, before, after);
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
  recordHistoryCommand(MovePanelCommand, before, after);
  renderAll();
}

// Orientation is decided at creation time now, not via a post-creation
// toggle — see the Vertical/Horizontal/Parallel buttons in the panel
// list. VERTICAL matches createPanelNode's own default rotation (a
// standing divider in the YZ plane); HORIZONTAL matches what the old
// Vertical/Horizontal inspector toggle produced for a flat shelf;
// PARALLEL is identity rotation — face lies in the XY plane, thickness
// along Z, same orientation the box preset uses for its 'back' panel.
function createAndSelectPanel(rotation) {
  const before = capturePanelsState();

  const node = createPanelNode({ rotation });
  node.basePosition = computeNextBasePosition(resolveConstraints(panels), node);
  panels = [...panels, node];

  const after = capturePanelsState();
  recordHistoryCommand(AddPanelCommand, before, after);
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

// Box preset — addBox() (features/box.js) is pure: it builds the six
// wall nodes (with Front already marked hidden — "open-front box")
// and returns { nodes, groupId } without touching this file's state.
// This is the one place that commits it: append via the shared
// commitAddedNodes() path, then select the new box as a whole.
function handleAddBox() {
  const { nodes, groupId } = addBox(panels); // ← must pass panels here
  commitAddedNodes(nodes, AddBoxCommand);
  setSelectedGroupId(groupId);
  setSelectedId(null);
  renderAll();
}

// A door's geometry depends on ALL 4 of its original boundary panels
// still existing (see features/door.js#applyDoorAdjustmentsForGroup,
// which looks every one of them back up by id on every relayout) —
// if one is gone, the door can never be correctly recomputed again.
// Called from BOTH removeSelected()'s branches: a shelf/door being
// truly deleted, and a box wall being hidden (restorable, but the
// person clearly no longer wants it there right now) — either way,
// `affectedNode`'s id stops meaning "a wall I can build a door
// against" the moment this runs, so any door depending on it is
// removed along with it rather than left frozen at stale geometry
// forever with no way to fix it. The person is told why via the same
// general-notice toast other operational side-effects already use
// (e.g. the design-limit/min-gap rejections just above) — unlike
// restoreFace()'s rejection, there's no longer a specific
// still-visible control this is "about": the affected panel's own
// inspector view is gone (deleted) or has moved on (hidden) by the
// time this runs.
function cascadeDeleteOrphanedDoors(panelsAfterChange, affectedNode) {
  const orphaned = panelsAfterChange.filter(
    (p) => p.isDoor && Object.values(p.boundaryIds || {}).includes(affectedNode.id)
  );
  if (orphaned.length === 0) return panelsAfterChange;

  showToast(
    `${getDisplayName(affectedNode)} was a boundary panel for ${orphaned.length === 1 ? 'a door' : `${orphaned.length} doors`} — removed automatically`
  );
  return panelsAfterChange.filter((p) => !orphaned.some((d) => d.id === p.id));
}

function removeSelected() {
  const groupId = getSelectedGroupId();
  const selectedId = getSelectedId();

  if (groupId && !selectedId) {
    // group-level selection (nothing drilled into) — permanent delete
    // of the whole group.
    const before = panels;
    panels = panels.filter((p) => p.groupId !== groupId);
    const after = panels;
    setSelectedGroupId(null);
    setSelectedId(panels.length > 0 ? panels[0].id : null);
    recordHistoryCommand(DeleteBoxCommand, before, after);
    renderAll();
    return;
  }

  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;

  if (node.groupId && (isShelf(node) || node.isDoor)) {
    // Shelves and doors have no "restore" concept — a shelf's
    // position, and a door's whole existence, are user choices, not
    // part of the box's own 6-wall structure — so removing either
    // erases it from the graph completely and immediately frees the
    // space it occupied. Critically, a door must NOT fall through to
    // the generic "hide it" branch below: a hidden-but-still-present
    // door would keep satisfying restoreFace()'s "a door exists in
    // this box" check forever, permanently blocking Front/Back/etc.
    // from ever being restorable again.
    const before = panels;
    let after = panels.filter((p) => p.id !== selectedId);
    after = cascadeDeleteOrphanedDoors(after, node);
    panels = after;
    setSelectedGroupId(node.groupId);
    setSelectedId(null);
    recordHistoryCommand(node.isDoor ? DeleteDoorCommand : DeleteShelfCommand, before, after);
    renderAll();
    return;
  }

  if (node.groupId) {
    // panel-level selection WITHIN a group — a box WALL face. HIDE it
    // rather than removing it from the graph (restorable via the
    // group inspector). Same cascade as the shelf/door branch above:
    // a door built using this exact wall as one of its 4 boundary
    // panels can no longer be trusted once that wall disappears from
    // view — hidden or truly deleted amounts to the same thing from
    // the door's perspective, so it's removed here too rather than
    // left referencing a wall the person just chose to hide.
    const before = panels;
    let after = panels.map((p) => (p.id === selectedId ? { ...p, hidden: true } : p));
    after = cascadeDeleteOrphanedDoors(after, node);
    panels = after;
    setSelectedGroupId(node.groupId);
    setSelectedId(null);
    recordHistoryCommand(HideBoxWallCommand, before, after);
    renderAll();
    return;
  }

  // plain standalone panel — permanent removal.
  const before = panels;
  panels = panels.filter((p) => p.id !== selectedId);
  const after = panels;
  setSelectedId(panels.length > 0 ? panels[0].id : null);
  recordHistoryCommand(DeletePanelCommand, before, after);
  renderAll();
}

// restoreFace()'s "a door exists" rejection needs to appear right
// next to the Restore button the person actually clicked — that
// button lives in ui/properties.js's #properties-container (the
// right-side inspector), a completely different part of the page
// from #toolbar-properties-toast (showToast's target, inside the
// LEFT-side #panel-list-mount toolbar). A showToast() call here would
// fire but render somewhere the person isn't looking — hence this
// separate bit of state, threaded through renderInspectorOnly() as
// `restoreError` instead, and rendered inline by properties.js itself.
let restoreBlockedMessage = null;
let restoreBlockedTimer = null;

function restoreFace(nodeId) {
  const node = panels.find((p) => p.id === nodeId);
  if (!node || !node.hidden) return;

  // A door was placed using this box's CURRENT walls as its boundary
  // (see features/door.js#computeDoorPlacement) — restoring a hidden
  // wall while any door still exists would put it right back into the
  // space the door's own placement already claimed, overlapping it.
  // Remove every door in the group first, then the wall can come back.
  const hasDoor = panels.some((p) => p.groupId === node.groupId && p.isDoor);
  if (hasDoor) {
    restoreBlockedMessage = `Can't restore ${getDisplayName(node)} while a door exists in this box — remove the door(s) first`;
    clearTimeout(restoreBlockedTimer);
    restoreBlockedTimer = setTimeout(() => {
      restoreBlockedMessage = null;
      renderAll();
    }, 4000);
    renderAll();
    return;
  }

  restoreBlockedMessage = null;
  clearTimeout(restoreBlockedTimer);
  const before = panels;
  panels = panels.map((p) => (p.id === nodeId ? { ...p, hidden: false } : p));
  const after = panels;
  recordHistoryCommand(RestoreBoxWallCommand, before, after);
  renderAll();
}

// Ephemeral VISUAL state, not a design edit — deliberately NOT pushed
// through history. Undo/redo shouldn't have to "undo" opening a door
// to eyeball clearance, any more than it undoes rotating the camera;
// the door's actual stored width/height/thickness/position never
// change (see features/door.js#computeDoorOpenTransform's own doc
// comment) — only how renderAll()'s scene-only copy of the panel list
// momentarily represents it.
function toggleSelectedDoorOpen() {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node || !node.isDoor) return;

  panels = panels.map((p) => (p.id === selectedId ? { ...p, doorOpen: !p.doorOpen } : p));
  renderAll();
}

// Unlike doorOpen above, which side a door hinges on IS a design
// decision (affects assembly/hardware later), so this goes through
// history like any other field edit.
function updateSelectedDoorHinge(hinge) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node || !node.isDoor || node.hinge === hinge) return;

  const before = panels;
  updateNode(selectedId, { hinge });
  const after = panels;
  recordHistoryCommand(SetDoorHingeCommand, before, after);
  renderAll();
}

// -------------------------------------------------------------
// Relation (constraint) CRUD — manual spansBetween/attachedTo
// creation now happens via the collinear tool and the shelf tool,
// both built on the same live-constraint approach.
// unlinkOrRemoveConstraint below is the one piece still needed here:
// both the properties panel's "Unlink" control and the relations
// list's own remove (×) button use it to detach/delete an EXISTING
// relation. Box walls never have entries here (they carry no
// constraints — see relayoutBox), so this never has to special-case
// isBoxWall.
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
  recordHistoryCommand(UnlinkConstraintCommand, before, after);
  renderAll();
}

// Initial state: a full box. addBox() (features/box.js) reads
// MATERIAL_CATALOG[0], which is only populated once
// loadMaterialCatalog() resolves — everything ABOVE this point (DOM
// refs, scene/gizmo wiring, every function declaration) has no
// dependency on the catalog and already ran synchronously at module
// load; only this first box needs to wait.
async function bootstrap() {
  await loadMaterialCatalog();
  handleAddBox();
  history.clear();
}
bootstrap();

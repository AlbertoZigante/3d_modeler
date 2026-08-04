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
  MATERIAL_CATALOG,
  nextConstraintId,
} from './modeller/modules.js';
import { resolveConstraints, inferSpanField } from './modeller/snap.js';
import { createModellerScene } from './modeller/scene.js';
import { getSelectedId, setSelectedId, getSelectedGroupId, setSelectedGroupId } from './modeller/selection.js';
import { computeBom } from './engine/bom.js';
import { renderProperties } from './ui/properties.js';
import { renderPanelList } from './ui/toolbar.js';
import { renderRelations } from './ui/relations.js';
import { initResizableLayout } from './ui/layout.js';

initResizableLayout();

// ---- THE GRAPH ----
// Seeded by hand here (rather than via computeNextBasePosition off an
// empty array + a real resolve) since there's no existing scene yet
// to resolve against — this is just the two-panel starting point,
// placed left-to-right with the same 300mm margin new panels always
// get afterward.
const SEED_ROTATION = { x: 0, y: 90, z: 0 }; // matches createPanelNode's own default
const seed1Dims = { width: 600, height: 720, thickness: 18, rotation: SEED_ROTATION };
const seed1BasePosition = computeNextBasePosition([], seed1Dims);
const seed1 = createPanelNode({ width: 600, height: 720, basePosition: seed1BasePosition });

const seed2Dims = { width: 560, height: 400, thickness: 18, rotation: SEED_ROTATION };
const seed2BasePosition = computeNextBasePosition(
  [{ position: seed1BasePosition, width: seed1.width, height: seed1.height, thickness: seed1.thickness, rotation: seed1.rotation }],
  seed2Dims
);
const seed2 = createPanelNode({ width: 560, height: 400, basePosition: seed2BasePosition });

let panels = [seed1, seed2];
setSelectedId(panels[0].id);

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

function showDesignLimitError(axis) {
  // const limit = DESIGN_LIMITS_MM[axis];
  designLimitToastEl.textContent = `Design limit reached for ${AXIS_LABEL[axis]}`; // can't exceed ${limit.max - limit.min}mm.`;
  designLimitToastEl.classList.add('visible');
  clearTimeout(designLimitHideTimer);
  designLimitHideTimer = setTimeout(() => designLimitToastEl.classList.remove('visible'), 2200);
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
const { reconcile, setViewMode } = createModellerScene(canvas, main, {
  axesCanvas,
  pipCanvas,
  onPipModeClick: (mode) => switchView(mode),
  onSelect: handleCanvasSelectClick,
  onTransformChange: (nodeId, transform) => {
    // High-frequency during drag: patch the graph, but skip the
    // full DOM re-render (mesh is already visually correct — the
    // gizmo drove it). We DO refresh the inspector so its live
    // offset/rotation readout tracks the drag.
    const node = panels.find((p) => p.id === nodeId);
    if (!node) return;
    const { offset, hitAxis } = clampOffsetToDesignLimits(node, transform.offset);
    updateNode(nodeId, { offset, rotation: transform.rotation });
    if (nodeId === getSelectedId()) renderInspectorOnly();
    if (hitAxis) {
      showDesignLimitError(hitAxis);
      return offset; // tells scene.js to snap the live mesh back to this clamped value
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
    // delta (see groupDragStartOffsets above for why this must be a
    // replace, not an accumulate).
    if (!groupDragStartOffsets) return; // drag start snapshot missing — ignore rather than guess
    // Design-limit enforcement is intentionally NOT applied to group
    // moves in this pass (see clampOffsetToDesignLimits for the
    // single-panel case) — correctly clamping a RIGID multi-member
    // move means finding the most restrictive limit across every
    // member and applying that SAME reduced delta to all of them,
    // which is a real design problem in its own right rather than a
    // small addition. Flagging as a known gap, not a silent omission.
    panels = panels.map((p) => {
      const start = groupDragStartOffsets.get(p.id);
      if (!start) return p;
      return {
        ...p,
        offset: { x: start.x + deltaMm.x, y: start.y + deltaMm.y, z: start.z + deltaMm.z },
      };
    });
  },
  onDimensionChange: (nodeId, dims, offsetDeltaMm) => {
    const current = panels.find((p) => p.id === nodeId);
    if (!current) return;
    const proposedOffset = offsetDeltaMm
      ? {
          x: current.offset.x + (offsetDeltaMm.x || 0),
          y: current.offset.y + (offsetDeltaMm.y || 0),
          z: current.offset.z + (offsetDeltaMm.z || 0),
        }
      : current.offset;
    const proposedPositionMm = {
      x: current.basePosition.x + proposedOffset.x,
      y: current.basePosition.y + proposedOffset.y,
      z: current.basePosition.z + proposedOffset.z,
    };
    const hitAxis = findDesignLimitViolation(current.rotation, proposedPositionMm, dims);
    if (hitAxis) {
      // Reject outright — gizmos.js/view2d.js already reset the
      // mesh's transient scale/position to pre-drag values before
      // calling this, so there's nothing further to visually correct.
      showDesignLimitError(hitAxis);
      return;
    }
    updateNode(nodeId, { width: dims.width, height: dims.height, thickness: dims.thickness, offset: proposedOffset });
    renderAll();
  },
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

  reconcile(visiblePanels, selectedId, selectedGroupId, multiSelectedIds);

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
    onAddConstraint: addConstraintToSelected,
    onUpdateConstraint: updateConstraintOnSelected,
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
// Relation (constraint) CRUD — the dropdown-based creation UI in
// relations.js calls these. No drag-to-snap in this pass: explicit,
// deterministic selection of node + face + offset is easier to get
// right and easier to test than proximity-based snapping, and can
// be layered on top of this exact same data later without changing
// the schema.
//
// Every create/update goes through `tryApplyConstraints`, which
// resolves a HYPOTHETICAL version of the graph first and only
// commits if that produces no warnings on the affected node — a
// relation that would come out broken (misaligned face, missing
// reference, etc.) is never actually created. relations.js shows
// the rejection reason inline and leaves the form as-is so the user
// can adjust and retry, rather than silently creating a broken
// relation the way it worked before this check existed.
// -------------------------------------------------------------
function tryApplyConstraints(nodeId, nextConstraintsForNode) {
  const hypothetical = panels.map((p) =>
    p.id === nodeId ? { ...p, constraints: nextConstraintsForNode } : p
  );
  const resolved = resolveConstraints(hypothetical);
  const resolvedNode = resolved.find((r) => r.id === nodeId);
  if (resolvedNode && resolvedNode.warnings.length > 0) {
    return { ok: false, error: resolvedNode.warnings.join(' ') };
  }
  panels = hypothetical;
  renderAll();
  return { ok: true };
}

// spansBetween relations no longer ask which field they set — panels
// are mostly a 2D shape (thickness is a small, fixed board value, not
// something you'd span between two other panels), so the field is
// inferred from the chosen From/To faces themselves. See snap.js's
// inferSpanField for the actual geometry.
function resolveConstraintField(node, draft) {
  if (draft.type !== 'spansBetween' || draft.field) return { ok: true, field: draft.field };
  const byId = new Map(panels.map((p) => [p.id, p]));
  const result = inferSpanField(node, draft.from, draft.to, byId);
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, field: result.field };
}

function addConstraintToSelected(constraintDraft) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return { ok: false, error: 'No panel selected.' };

  const fieldResult = resolveConstraintField(node, constraintDraft);
  if (!fieldResult.ok) return fieldResult;

  const withId = { ...constraintDraft, field: fieldResult.field, id: nextConstraintId(), overridden: false };
  // one active constraint per field at a time — adding a new one
  // for a field replaces rather than stacks
  const nextConstraints = [
    ...(node.constraints || []).filter((c) => c.field !== withId.field),
    withId,
  ];
  return tryApplyConstraints(selectedId, nextConstraints);
}

// Replaces an EXISTING constraint's definition in place (same id, so
// the relations list's "editing" highlight and click-to-toggle state
// in relations.js keep referring to the same row) — used by the
// "Update" button when editing a relation, as opposed to
// addConstraintToSelected's "Apply", which always creates a new one.
// Re-activates it (overridden: false) even if it had been unlinked,
// since updating it is the user's way of consciously re-linking.
function updateConstraintOnSelected(constraintId, newConstraintDraft) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return { ok: false, error: 'No panel selected.' };

  const fieldResult = resolveConstraintField(node, newConstraintDraft);
  if (!fieldResult.ok) return fieldResult;

  const nextConstraints = (node.constraints || []).map((c) =>
    c.id === constraintId ? { ...newConstraintDraft, field: fieldResult.field, id: constraintId, overridden: false } : c
  );
  return tryApplyConstraints(selectedId, nextConstraints);
}

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

function addBox() {
  const W = DEFAULT_BOX_WIDTH_MM;
  const H = DEFAULT_BOX_HEIGHT_MM;
  const D = DEFAULT_BOX_DEPTH_MM;
  const material = MATERIAL_CATALOG[0].name;
  const T = MATERIAL_CATALOG[0].thicknessMm;

  const left = createPanelNode({ name: 'Left', width: D, height: H, thickness: T, material, rotation: { x: 0, y: 90, z: 0 } });
  const right = createPanelNode({ name: 'Right', width: D, height: H, thickness: T, material, rotation: { x: 0, y: 90, z: 0 } });

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
  // circular anyway. Left/right stay the sole literal "source of
  // truth" panels; everything else derives from them.
  const nextId = () => nextConstraintId();

  // top/bottom span the OUTER faces — full width W, covering over
  // left/right's edges rather than being tucked between them.
  const outerWidthSpan = () => [{
    field: 'width', type: 'spansBetween', overridden: false,
    from: { node: left.id, face: 'back', offset: 0 },
    to: { node: right.id, face: 'front', offset: 0 },
    id: nextId(),
  }];
  // back keeps the ORIGINAL inner-fitted width (grooved between the
  // sides) — not part of this change, W-2T as before.
  const innerWidthSpan = () => [{
    field: 'width', type: 'spansBetween', overridden: false,
    from: { node: left.id, face: 'front', offset: 0 },
    to: { node: right.id, face: 'back', offset: 0 },
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
    constraints: [
      ...outerWidthSpan(),
      ...depthMatchesLeft(),
      // sits flush ABOVE left's top edge (its own underside touching
      // left's topside from outside) — no gap, no overlap
      { field: 'positionY', type: 'attachedTo', overridden: false, myFace: 'front', from: { node: left.id, face: 'top', offset: 0 }, id: nextId() },
    ],
  });
  const bottom = createPanelNode({
    name: 'Bottom',
    width: W, height: D, thickness: T, material, rotation: { x: 90, y: 0, z: 0 },
    constraints: [
      ...outerWidthSpan(),
      ...depthMatchesLeft(),
      // sits flush BELOW left's bottom edge, same idea mirrored
      { field: 'positionY', type: 'attachedTo', overridden: false, myFace: 'back', from: { node: left.id, face: 'bottom', offset: 0 }, id: nextId() },
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
    constraints: [
      ...outerWidthSpan(),
      // height spans top's OUTER (upper) edge to bottom's OUTER
      // (lower) edge — 'back'/'front' here are top/bottom's own
      // thickness-axis faces (their topside/underside respectively).
      { field: 'height', type: 'spansBetween', overridden: false,
        from: { node: top.id, face: 'back', offset: 0 },
        to: { node: bottom.id, face: 'front', offset: 0 }, id: nextId() },
      // flush against left's BACK edge, extending further back —
      // tracks depth (D) automatically, unlike a literal Z offset.
      { field: 'positionZ', type: 'attachedTo', overridden: false,
        myFace: 'front', from: { node: left.id, face: 'right', offset: 0 }, id: nextId() },
    ],
  });
  const front = createPanelNode({
    name: 'Front',
    // Inner-fitted, same footprint the original single-panel back
    // used to have — grooved between the sides rather than covering
    // them, unlike the new back above. Height still tracks H (via
    // left's own top/bottom faces) so it isn't left stale on resize.
    width: W - 2 * T, height: H, thickness: T, material, rotation: { x: 0, y: 0, z: 0 },
    constraints: [
      ...innerWidthSpan(),
      { field: 'height', type: 'spansBetween', overridden: false,
        from: { node: left.id, face: 'top', offset: 0 },
        to: { node: left.id, face: 'bottom', offset: 0 }, id: nextId() },
      // flush against left's FRONT edge, extending further forward.
      { field: 'positionZ', type: 'attachedTo', overridden: false,
        myFace: 'back', from: { node: left.id, face: 'left', offset: 0 }, id: nextId() },
    ],
  });

  const boxPanels = [left, right, top, bottom, back, front];
  boxPanels.forEach((p) => { p.groupId = left.id; }); // left's own id doubles as the group's identifier — no separate id generator needed

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

  const desired = new Map([ // top/bottom/back/front are all positioned relative to the box's anchor, which is at the bottom of the box (floor level) rather than halfway up like the old version did
    [left.id, { x: -(W / 2 - T / 2), y: H/2 + FLOOR_MM, z: 0 }], //  y: H/2 + FLOOR_MM, z: 0 }]
    [right.id, { x: W / 2 - T / 2, y: H/2 + FLOOR_MM, z: 0 }],
  ]);

  const anchor = computeNextBasePosition(resolveConstraints(panels), { width: W, height: H, thickness: T, rotation: { x: 0, y: 0, z: 0 } });
  boxPanels.forEach((p) => { p.basePosition = anchor; });
  [left, right].forEach((p) => {
    const want = desired.get(p.id);
    p.offset = { x: want.x, y: want.y, z: want.z };
  });
  // top/bottom/back/front: EVERY axis is now constraint-derived — X
  // (and, for back, Y too) by spansBetween's auto-centering, the
  // remaining position axis by an attachedTo — so their literal
  // offset is just a zeroed placeholder, never actually read while
  // those constraints stay linked.
  [top, bottom, back, front].forEach((p) => { p.offset = { x: 0, y: 0, z: 0 }; }); // 

  panels = [...panels, ...boxPanels]; // always appended — never replaces an existing panel
  setSelectedGroupId(left.id);
  setSelectedId(null);
  renderAll();
}

renderAll();

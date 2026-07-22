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
  MM_TO_UNIT,
  computeAutoLayoutPositions,
  nextConstraintId,
} from './modeller/modules.js';
import { resolveConstraints, inferSpanField } from './modeller/snap.js';
import { createModellerScene } from './modeller/scene.js';
import { getSelectedId, setSelectedId } from './modeller/selection.js';
import { computeBom } from './engine/bom.js';
import { renderProperties } from './ui/properties.js';
import { renderPanelList } from './ui/toolbar.js';
import { renderRelations } from './ui/relations.js';
import { initResizableLayout } from './ui/layout.js';

initResizableLayout();

// ---- THE GRAPH ----
let panels = [
  createPanelNode({ width: 600, height: 720 }),
  createPanelNode({ width: 560, height: 400 }),
];
setSelectedId(panels[0].id);

// ---- DOM refs ----
const canvas = document.getElementById('canvas');
const main = document.getElementById('main');
const panelListMountEl = document.getElementById('panel-list-mount');
const relationsMountEl = document.getElementById('relations-mount');
const inspectorEl = document.getElementById('properties-container');
const bomBodyEl = document.getElementById('bom-body');
const stageLabelEl = document.getElementById('stage-label');
const axesCanvas = document.getElementById('axes-gizmo-canvas');

// ---- Scene (view layer). Consumes RESOLVED panels only. ----
const { reconcile, setViewMode, setFacePickMode } = createModellerScene(canvas, main, {
  axesCanvas,
  onSelect: (id) => {
    setSelectedId(id);
    resetFacePicks();
    renderAll();
  },
  onTransformChange: (nodeId, transform) => {
    // High-frequency during drag: patch the graph, but skip the
    // full DOM re-render (mesh is already visually correct — the
    // gizmo drove it). We DO refresh the inspector so its live
    // offset/rotation readout tracks the drag.
    updateNode(nodeId, { offset: transform.offset, rotation: transform.rotation });
    if (nodeId === getSelectedId()) renderInspectorOnly();
  },
  onDimensionChange: (nodeId, dims) => {
    updateNode(nodeId, { width: dims.width, height: dims.height, thickness: dims.thickness });
    renderAll();
  },
  onFacePick: (which, nodeId, faceName) => {
    if (which === 'from') facePicks.from = { node: nodeId, face: faceName };
    else if (which === 'to') facePicks.to = { node: nodeId, face: faceName };
    renderAll();
  },
});

// -------------------------------------------------------------
// FACE PICKING (item 11) — lets the relations form's "From"/"To"
// face for a spansBetween relation be picked directly in the 3D
// view instead of via dropdowns. `facePicks` is local UI state (not
// part of the graph): it only matters to the currently-open relation
// form, the same way relations.js's own `editingConstraintId` does.
// startFacePicking puts scene.js into "next click picks a face"
// mode; the callback above records the result and re-renders, which
// makes reconcile() color that face green/red (see scene.js).
// -------------------------------------------------------------
const facePicks = { from: null, to: null };

function startFacePicking(which) {
  setFacePickMode(which);
}

function clearFacePick(which) {
  facePicks[which] = null;
  renderAll();
}

function resetFacePicks() {
  facePicks.from = null;
  facePicks.to = null;
}

// When relations.js loads an existing spansBetween relation into the
// edit form, this pre-fills facePicks with that relation's current
// From/To — so the 3D view immediately shows what's already set (and
// the user can leave it as-is, or click Pick again to change just
// one side) rather than starting edit mode from a blank slate.
function loadFacePicksForEdit(from, to) {
  facePicks.from = from || null;
  facePicks.to = to || null;
  renderAll();
}

// -------------------------------------------------------------
// 3D / 2D view mode toggle. Purely a rendering/interaction switch —
// nothing about the graph, resolver, BOM, or inspector changes
// based on which view is active.
// -------------------------------------------------------------
const view3dBtn = document.getElementById('view-3d-btn');
const view2dBtn = document.getElementById('view-2d-btn');
const hintBar3d = document.getElementById('hint-bar-3d');
const hintBar2d = document.getElementById('hint-bar-2d');

view3dBtn.addEventListener('click', () => {
  setSelectedId(null); // deselect on every mode switch — no gizmo/handle can be left stuck
  resetFacePicks();
  setViewMode('3d');
  view3dBtn.classList.add('active');
  view2dBtn.classList.remove('active');
  hintBar3d.style.display = '';
  hintBar2d.style.display = 'none';
  renderAll();
});
view2dBtn.addEventListener('click', () => {
  setSelectedId(null);
  resetFacePicks(); // face picking is 3D-only for now
  setViewMode('2d');
  view2dBtn.classList.add('active');
  view3dBtn.classList.remove('active');
  hintBar3d.style.display = 'none';
  hintBar2d.style.display = '';
  renderAll();
});

// -------------------------------------------------------------
// Single generic graph-mutation primitive (Stage 2 consolidation:
// every function below patches `panels` through this one function
// instead of each hand-rolling its own `.map(...)`).
// -------------------------------------------------------------
function updateNode(id, patch) {
  panels = panels.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

function renderAll() {
  const selectedId = getSelectedId();
  const resolved = resolveConstraints(panels);

  reconcile(resolved, selectedId, facePicks);

  renderPanelList(panelListMountEl, {
    panels: resolved,
    selectedId,
    onSelect: (id) => {
      setSelectedId(id);
      resetFacePicks();
      renderAll();
    },
    onAdd: addPanel,
  });

  renderInspectorOnly();

  const rows = computeBom(resolved);
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

  stageLabelEl.textContent = `${panels.length} node(s) · constraints active`;
}

function renderInspectorOnly() {
  const selectedId = getSelectedId();
  const selectedPanel = panels.find((p) => p.id === selectedId) || null;
  // Recomputed here too (not threaded from renderAll) so the
  // high-frequency onTransformChange path above always reflects the
  // current state of every field, not a stale snapshot.
  const resolved = resolveConstraints(panels);
  const resolvedPanel = resolved.find((r) => r.id === selectedId) || null;

  renderProperties(inspectorEl, {
    selectedPanel,
    resolvedPanel,
    onFieldChange: updateSelectedField,
    onTransformFieldChange: updateSelectedTransformField,
    onResetTransform: resetSelectedTransform,
    onSetOrientation: setSelectedOrientation,
    onCreateBox: addBoxFromSelection,
    onUnlinkConstraint: unlinkOrRemoveConstraint,
    onRename: renameSelected,
    onRemove: removeSelected,
  });

  renderRelations(relationsMountEl, {
    selectedPanel,
    allPanels: panels,
    facePicks,
    onStartPicking: startFacePicking,
    onClearPick: clearFacePick,
    onLoadPicksForEdit: loadFacePicksForEdit,
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
  updateNode(getSelectedId(), { [field]: value });
  renderAll();
}

function updateSelectedTransformField(group, axis, value) {
  const selectedId = getSelectedId();
  const node = panels.find((p) => p.id === selectedId);
  if (!node) return;
  updateNode(selectedId, { [group]: { ...node[group], [axis]: value } });
  renderAll();
}

function setSelectedOrientation(orientation) {
  const rotationX = orientation === 'horizontal' ? 90 : 0;
  updateNode(getSelectedId(), { rotation: { x: rotationX, y: 0, z: 0 } });
  renderAll();
}

function resetSelectedTransform() {
  updateNode(getSelectedId(), { offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });
  renderAll();
}

function addPanel() {
  const node = createPanelNode(); // picks up the default square, YZ-plane orientation
  panels = [...panels, node];
  setSelectedId(node.id);
  resetFacePicks();
  renderAll();
}

function removeSelected() {
  const selectedId = getSelectedId();
  panels = panels.filter((p) => p.id !== selectedId);
  setSelectedId(panels.length > 0 ? panels[0].id : null);
  resetFacePicks();
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
  if (constraintDraft.type === 'spansBetween' && (!constraintDraft.from || !constraintDraft.to)) {
    return { ok: false, error: 'Pick both a "From" and a "To" face in the 3D view first.' };
  }

  const fieldResult = resolveConstraintField(node, constraintDraft);
  if (!fieldResult.ok) return fieldResult;

  const withId = { ...constraintDraft, field: fieldResult.field, id: nextConstraintId(), overridden: false };
  // one active constraint per field at a time — adding a new one
  // for a field replaces rather than stacks
  const nextConstraints = [
    ...(node.constraints || []).filter((c) => c.field !== withId.field),
    withId,
  ];
  const result = tryApplyConstraints(selectedId, nextConstraints);
  if (result.ok) resetFacePicks();
  return result;
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
  if (newConstraintDraft.type === 'spansBetween' && (!newConstraintDraft.from || !newConstraintDraft.to)) {
    return { ok: false, error: 'Pick both a "From" and a "To" face in the 3D view first.' };
  }

  const fieldResult = resolveConstraintField(node, newConstraintDraft);
  if (!fieldResult.ok) return fieldResult;

  const nextConstraints = (node.constraints || []).map((c) =>
    c.id === constraintId ? { ...newConstraintDraft, field: fieldResult.field, id: constraintId, overridden: false } : c
  );
  const result = tryApplyConstraints(selectedId, nextConstraints);
  if (result.ok) resetFacePicks();
  return result;
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
    // (a delta from the auto-layout fallback). Convert the current
    // resolved absolute position back into the offset that would
    // reproduce it, so unlinking doesn't move the panel.
    const axis = field === 'positionX' ? 'x' : field === 'positionY' ? 'y' : 'z';
    const autoPos = computeAutoLayoutPositions(panels).get(selectedId);
    const autoMm = autoPos[axis] / MM_TO_UNIT;
    const currentMm = resolvedNode ? resolvedNode.position[axis] : autoMm;
    patch.offset = { ...node.offset, [axis]: currentMm - autoMm };
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

function addBoxFromSelection() {
  const selectedId = getSelectedId();
  const basis = panels.find((p) => p.id === selectedId);
  if (!basis) return;

  const W = basis.width;
  const H = basis.height;
  const T = basis.thickness;
  const D = DEFAULT_BOX_DEPTH_MM;
  const material = basis.material;

  const left = createPanelNode({ width: D, height: H, thickness: T, material, rotation: { x: 0, y: 90, z: 0 } });
  const right = createPanelNode({ width: D, height: H, thickness: T, material, rotation: { x: 0, y: 90, z: 0 } });

  // Face choice verified directly against the resolver (see the
  // standalone test run while building this): with both side panels
  // rotated 90° about Y, their LOCAL 'front' face maps to WORLD +X
  // and 'back' maps to WORLD -X — so left's inner (rightward-facing)
  // face is 'front', and right's inner (leftward-facing) face is
  // 'back'. Getting this wrong doesn't silently break — the resolver
  // would reject a genuinely misaligned face with a clear warning.
  const spanConstraint = () => [{
    field: 'width', type: 'spansBetween', overridden: false,
    from: { node: left.id, face: 'front', offset: 0 },
    to: { node: right.id, face: 'back', offset: 0 },
  }].map((c) => ({ ...c, id: nextConstraintId() }));

  const top = createPanelNode({
    width: W - 2 * T, height: D, thickness: T, material, rotation: { x: 90, y: 0, z: 0 },
    constraints: spanConstraint(),
  });
  const bottom = createPanelNode({
    width: W - 2 * T, height: D, thickness: T, material, rotation: { x: 90, y: 0, z: 0 },
    constraints: spanConstraint(),
  });
  const back = createPanelNode({
    width: W - 2 * T, height: H, thickness: T, material, rotation: { x: 0, y: 0, z: 0 },
    constraints: spanConstraint(),
  });

  const boxPanels = [left, right, top, bottom, back];
  const idx = panels.findIndex((p) => p.id === selectedId);
  const nextPanels = [...panels.slice(0, idx), ...boxPanels, ...panels.slice(idx + 1)];

  // left/right are still literal, independent "anchors" — positioned
  // via the same offset-cancellation technique as the Stage 1 box
  // preset (unchanged). Only top/bottom/back's WIDTH moved to a real
  // constraint above; their Y/Z offsets below are still literal.
  const w = W * MM_TO_UNIT, h = H * MM_TO_UNIT, d = D * MM_TO_UNIT, t = T * MM_TO_UNIT;
  const desired = new Map([
    [left.id, { x: -(w / 2 - t / 2), y: h / 2 - 0.5, z: 0 }],
    [right.id, { x: w / 2 - t / 2, y: h / 2 - 0.5, z: 0 }],
    [top.id, { x: 0, y: h - t / 2 - 0.5, z: 0 }],
    [bottom.id, { x: 0, y: t / 2 - 0.5, z: 0 }],
    [back.id, { x: 0, y: h / 2 - 0.5, z: -(d / 2 - t / 2) }],
  ]);
  const autoBase = computeAutoLayoutPositions(nextPanels);

  [left, right].forEach((p) => {
    const base = autoBase.get(p.id);
    const want = desired.get(p.id);
    p.offset = {
      x: (want.x - base.x) / MM_TO_UNIT,
      y: (want.y - base.y) / MM_TO_UNIT,
      z: (want.z - base.z) / MM_TO_UNIT,
    };
  });
  [top, bottom, back].forEach((p) => {
    const base = autoBase.get(p.id);
    const want = desired.get(p.id);
    // x is governed entirely by the spansBetween constraint now
    // (which also centers the node on that axis) — only y/z matter.
    p.offset = { x: 0, y: (want.y - base.y) / MM_TO_UNIT, z: (want.z - base.z) / MM_TO_UNIT };
  });

  panels = nextPanels;
  setSelectedId(left.id);
  renderAll();
}

renderAll();

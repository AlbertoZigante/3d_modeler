/**
 * Entry point for the modeller page. This is the only file that
 * is allowed to mutate `panels` — every module above only reads
 * data or fires callbacks back up to here. That single-writer
 * rule is what keeps "graph -> view" one-directional as this
 * grows past Stage 0.
 */
import { createPanelNode, MM_TO_UNIT, computeAutoLayoutPositions } from './modeller/modules.js';
import { createModellerScene } from './modeller/scene.js';
import { getSelectedId, setSelectedId } from './modeller/selection.js';
import { computeBom } from './engine/bom.js';
import { renderProperties } from './ui/properties.js';
import { renderPanelList } from './ui/toolbar.js';
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
const listPanelEl = document.getElementById('list-panel');
const inspectorEl = document.getElementById('properties-container');
const bomBodyEl = document.getElementById('bom-body');
const stageLabelEl = document.getElementById('stage-label');

// ---- Scene (view layer). onSelect fires from raycast clicks (including
// null on empty-space clicks, which deselects); onTransformChange fires
// continuously while a move/rotate gizmo is dragged; onDimensionChange
// fires once, on release, after a resize-gizmo drag.
const { reconcile } = createModellerScene(canvas, main, {
  onSelect: (id) => {
    setSelectedId(id);
    renderAll();
  },
  onTransformChange: (nodeId, transform) => {
    // High-frequency during drag: patch the graph, but skip the
    // full DOM re-render (mesh is already visually correct — the
    // gizmo drove it). We DO refresh the inspector's numeric
    // fields so the live offset/rotation readout tracks the drag.
    panels = panels.map((p) =>
      p.id === nodeId ? { ...p, offset: transform.offset, rotation: transform.rotation } : p
    );
    if (nodeId === getSelectedId()) renderInspectorOnly();
  },
  onDimensionChange: (nodeId, dims) => {
    panels = panels.map((p) =>
      p.id === nodeId
        ? { ...p, width: dims.width, height: dims.height, thickness: dims.thickness }
        : p
    );
    renderAll();
  },
});

function renderAll() {
  const selectedId = getSelectedId();

  reconcile(panels, selectedId);

  renderPanelList(listPanelEl, {
    panels,
    selectedId,
    onSelect: (id) => {
      setSelectedId(id);
      renderAll();
    },
    onAdd: addPanel,
  });

  renderInspectorOnly();
  renderBom();
  stageLabelEl.textContent = `${panels.length} node(s) · no relations yet`;
}

function renderInspectorOnly() {
  const selectedId = getSelectedId();
  const selectedPanel = panels.find((p) => p.id === selectedId) || null;
  renderProperties(inspectorEl, {
    selectedPanel,
    onFieldChange: updateSelectedField,
    onTransformFieldChange: updateSelectedTransformField,
    onResetTransform: resetSelectedTransform,
    onSetOrientation: setSelectedOrientation,
    onCreateBox: addBoxFromSelection,
    onRemove: removeSelected,
  });
}

function renderBom() {
  const rows = computeBom(panels);
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
}

function updateSelectedField(field, value) {
  const selectedId = getSelectedId();
  panels = panels.map((p) => (p.id === selectedId ? { ...p, [field]: value } : p));
  renderAll();
}

function updateSelectedTransformField(group, axis, value) {
  const selectedId = getSelectedId();
  panels = panels.map((p) =>
    p.id === selectedId ? { ...p, [group]: { ...p[group], [axis]: value } } : p
  );
  renderAll();
}

function setSelectedOrientation(orientation) {
  const selectedId = getSelectedId();
  const rotationX = orientation === 'horizontal' ? 90 : 0;
  panels = panels.map((p) =>
    p.id === selectedId ? { ...p, rotation: { x: rotationX, y: 0, z: 0 } } : p
  );
  renderAll();
}

/**
 * Box preset: replaces the selected panel with 5 real, independent
 * panel nodes forming an open-front box — left, right, top, bottom,
 * back — using the selected panel's width/height/thickness/material
 * as the box's outer envelope. Depth has no dedicated field yet, so
 * it defaults to 400mm; adjust it afterward the same way as any
 * other panel dimension (each generated panel is a normal node).
 *
 * Placement uses the same `offset`-from-auto-layout mechanism the
 * gizmo already writes to: we compute where each panel SHOULD sit
 * in box-local space, look up where auto-layout would have put it
 * (via the shared computeAutoLayoutPositions, same function scene.js
 * uses), and set offset = desired - auto. This is a temporary
 * workaround — Stage 2's spans_between relations will let a box's
 * panels declare their relationship to each other directly instead
 * of each independently cancelling out a placeholder layout.
 */
const DEFAULT_BOX_DEPTH_MM = 400;
const MIN_INNER_DIM_MM = 10;

function addBoxFromSelection() {
  const selectedId = getSelectedId();
  const basis = panels.find((p) => p.id === selectedId);
  if (!basis) return;

  const W = basis.width;
  const H = basis.height;
  const T = basis.thickness;
  const D = DEFAULT_BOX_DEPTH_MM;
  const material = basis.material;
  const innerWidth = Math.max(MIN_INNER_DIM_MM, W - 2 * T);

  const left = createPanelNode({ width: D, height: H, thickness: T, material, rotation: { x: 0, y: 90, z: 0 } });
  const right = createPanelNode({ width: D, height: H, thickness: T, material, rotation: { x: 0, y: 90, z: 0 } });
  const top = createPanelNode({ width: innerWidth, height: D, thickness: T, material, rotation: { x: 90, y: 0, z: 0 } });
  const bottom = createPanelNode({ width: innerWidth, height: D, thickness: T, material, rotation: { x: 90, y: 0, z: 0 } });
  const back = createPanelNode({ width: innerWidth, height: H, thickness: T, material, rotation: { x: 0, y: 0, z: 0 } });
  const boxPanels = [left, right, top, bottom, back];

  const idx = panels.findIndex((p) => p.id === selectedId);
  const nextPanels = [...panels.slice(0, idx), ...boxPanels, ...panels.slice(idx + 1)];

  // Desired position, in box-local metres (W/H/D/T converted from
  // mm), box centered on X and Z, sitting on the ground (y = -0.5
  // matches the same ground-level convention every other panel uses).
  const w = W * MM_TO_UNIT, h = H * MM_TO_UNIT, d = D * MM_TO_UNIT, t = T * MM_TO_UNIT;
  const desired = new Map([
    [left.id, { x: -(w / 2 - t / 2), y: h / 2 - 0.5, z: 0 }],
    [right.id, { x: w / 2 - t / 2, y: h / 2 - 0.5, z: 0 }],
    [top.id, { x: 0, y: h - t / 2 - 0.5, z: 0 }],
    [bottom.id, { x: 0, y: t / 2 - 0.5, z: 0 }],
    [back.id, { x: 0, y: h / 2 - 0.5, z: -(d / 2 - t / 2) }],
  ]);

  const autoBase = computeAutoLayoutPositions(nextPanels);
  boxPanels.forEach((p) => {
    const base = autoBase.get(p.id);
    const want = desired.get(p.id);
    p.offset = {
      x: (want.x - base.x) / MM_TO_UNIT,
      y: (want.y - base.y) / MM_TO_UNIT,
      z: (want.z - base.z) / MM_TO_UNIT,
    };
  });

  panels = nextPanels;
  setSelectedId(left.id);
  renderAll();
}

function resetSelectedTransform() {
  const selectedId = getSelectedId();
  panels = panels.map((p) =>
    p.id === selectedId
      ? { ...p, offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
      : p
  );
  renderAll();
}

function addPanel() {
  const node = createPanelNode({ width: 500, height: 500 });
  panels = [...panels, node];
  setSelectedId(node.id);
  renderAll();
}

function removeSelected() {
  const selectedId = getSelectedId();
  panels = panels.filter((p) => p.id !== selectedId);
  if (panels.length > 0) setSelectedId(panels[0].id);
  renderAll();
}

renderAll();

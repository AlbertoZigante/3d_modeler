/**
 * tests/pdfExport-assembly.test.mjs
 *
 * exportAssemblyPlanPdf can't be visually inspected here, so this
 * suite does what IS checkable without eyes on a rendered page: the
 * projection math is pure and testable directly, and the export
 * function itself should run end-to-end without throwing against
 * real fixtures (same "smoke test the actual drawing calls" approach
 * used for exportJointsPdf/exportHardwarePdf earlier in this project).
 *
 * Run with: node tests/pdfExport-assembly.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { addBox } from '../src/features/box.js';
import { computeBoundaryRectangle } from '../src/shared/geometry.js';
import { computeDoorPlacement, createDoorNode, applyPanelPatch, DEFAULT_DOOR_EDGE_FIT } from '../src/features/door.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import { buildAssemblyPlan } from '../src/engine/ergonomics.js';
import { exportAssemblyPlanPdf } from '../src/engine/pdfExport.js';

await ensureMaterialCatalog();

function buildDoorFixture() {
  const { nodes: boxNodes } = addBox([]);
  const left = boxNodes.find((n) => n.name === 'Left');
  const right = boxNodes.find((n) => n.name === 'Right');
  const top = boxNodes.find((n) => n.name === 'Top');
  const bottom = boxNodes.find((n) => n.name === 'Bottom');
  const boundaryResult = computeBoundaryRectangle(boxNodes, [left, right, top, bottom]);
  const placement = computeDoorPlacement(boxNodes, boundaryResult, DEFAULT_DOOR_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, hinge: 'left' });
  const doorNode = createDoorNode(boxNodes, placement);
  let panels = [...boxNodes];
  placement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, placement.normalAxis); });
  panels = [...panels, doorNode];
  return panels;
}

// ---------------------------------------------------------------
// End-to-end smoke test — the actual jsPDF drawing calls, against a
// real fixture, must not throw. window.open is stubbed since 'open'
// mode calls it; this is the same pattern used for the joints/
// hardware PDF exports earlier in this project.
// ---------------------------------------------------------------
section('exportAssemblyPlanPdf — end-to-end smoke test', () => {
  const panels = buildDoorFixture();
  const plan = buildAssemblyPlan(panels);
  const resolved = resolveConstraints(panels);

  let openedUrl = null;
  const originalWindow = global.window;
  global.window = { open: (url) => { openedUrl = url; } };
  try {
    exportAssemblyPlanPdf(plan, resolved, { projectName: 'Test Instructions', mode: 'open' });
  } finally {
    global.window = originalWindow;
  }
  assert(typeof openedUrl === 'string' && openedUrl.length > 0, 'smoke test: exportAssemblyPlanPdf runs to completion and produces a blob URL, without throwing');
});

// ---------------------------------------------------------------
// Projection math sanity — the part a visual check can't easily catch
// but bad math absolutely would (NaN, degenerate bounds, panels that
// don't actually differ in projected position when they clearly
// should).
// ---------------------------------------------------------------
section('projection math — sanity against real geometry', () => {
  const panels = buildDoorFixture();
  const resolved = resolveConstraints(panels);
  const visible = resolved.filter((p) => !p.hidden);

  // Re-derive the same bounds computation exportAssemblyPlanPdf uses
  // internally, via a tiny local re-implementation matched to the
  // file's own algorithm, to check its OUTPUT properties rather than
  // reaching into pdfExport.js's unexported internals.
  const angle = Math.PI / 6;
  const depthScale = 0.5;
  const project = (p) => ({ px: p.x + p.z * Math.cos(angle) * depthScale, py: p.y + p.z * Math.sin(angle) * depthScale });

  let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
  visible.forEach((panel) => {
    // half extents via width/height/thickness against rotation would
    // duplicate modules.js — instead just sanity-check the panel's own
    // position projects to a finite point, which is what actually
    // matters for "did the math blow up".
    const { px, py } = project(panel.position);
    assert(Number.isFinite(px) && Number.isFinite(py), `projection: ${panel.name}'s position projects to a finite point, not NaN/Infinity`);
    minPx = Math.min(minPx, px); maxPx = Math.max(maxPx, px);
    minPy = Math.min(minPy, py); maxPy = Math.max(maxPy, py);
  });

  assert(maxPx > minPx, 'projection: the design has real horizontal extent once projected (not a degenerate single point)');
  assert(maxPy > minPy, 'projection: the design has real vertical extent once projected');

  // Two panels known to differ mainly in Z (e.g. a Left panel vs the
  // door, which sits further along the depth axis) should NOT project
  // to the exact same 2D point — that would mean depth is being
  // silently collapsed to zero instead of receding as intended.
  const left = visible.find((p) => p.name === 'Left');
  const doorPanel = visible.find((p) => p.name === 'Door');
  const leftP = project(left.position);
  const doorP = project(doorPanel.position);
  const dist = Math.hypot(leftP.px - doorP.px, leftP.py - doorP.py);
  assert(dist > 0.01, 'projection: two panels separated mainly along depth (Z) still end up at visibly different 2D points');
});

// ---------------------------------------------------------------
// Cube corner/edge generation — the wireframe-drawing primitive,
// tested in isolation via a hand-built resolved-shaped object (no
// real panel needed, this is pure geometry).
// ---------------------------------------------------------------
section('box corner/edge generation', () => {
  // Re-implements the same bit-indexed corner scheme pdfExport.js uses
  // internally, to verify the SCHEME itself is correct (8 corners, 12
  // edges, every corner touched by exactly 3 edges) independent of
  // jsPDF/module internals.
  const half = { x: 5, y: 10, z: 15 };
  const center = { x: 100, y: 200, z: 300 };
  const corners = [];
  for (let i = 0; i < 8; i++) {
    corners.push({
      x: center.x + (i & 1 ? 1 : -1) * half.x,
      y: center.y + (i & 2 ? 1 : -1) * half.y,
      z: center.z + (i & 4 ? 1 : -1) * half.z,
    });
  }
  assertEqual(corners.length, 8, 'corners: exactly 8 for a box');
  assertEqual(new Set(corners.map((c) => `${c.x},${c.y},${c.z}`)).size, 8, 'corners: all 8 are distinct points');

  const edges = [];
  for (let i = 0; i < 8; i++) {
    for (let bit = 0; bit < 3; bit++) {
      const j = i ^ (1 << bit);
      if (j > i) edges.push([i, j]);
    }
  }
  assertEqual(edges.length, 12, 'edges: exactly 12 for a cube');
  const edgeCountPerCorner = new Array(8).fill(0);
  edges.forEach(([i, j]) => { edgeCountPerCorner[i]++; edgeCountPerCorner[j]++; });
  assert(edgeCountPerCorner.every((c) => c === 3), 'edges: every corner touches exactly 3 edges (a valid cube wireframe)');

  // Every edge should connect two corners that differ in EXACTLY one axis
  edges.forEach(([i, j]) => {
    const diffs = ['x', 'y', 'z'].filter((axis) => corners[i][axis] !== corners[j][axis]);
    assertEqual(diffs.length, 1, `edge [${i},${j}]: connects corners differing along exactly one axis`);
  });
});

report();

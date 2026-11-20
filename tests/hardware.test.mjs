/**
 * tests/hardware.test.mjs
 *
 * Empirical test harness for engine/hardware.js (the live-validation subset: hinge + connector selection and table rows;
 * the hardware PLAN is the API's, tested in the api repo) — same convention as
 * tests/joints.test.mjs: real fixtures built from the actual
 * addBox()/door.js/drawer.js pipeline, exact assertions, not "doesn't
 * crash" checks.
 *
 * Run with: node tests/hardware.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { addBox } from '../src/features/box.js';
import { computeBoundaryRectangle } from '../src/shared/geometry.js';
import { computeDoorPlacement, createDoorNode, applyPanelPatch, DEFAULT_DOOR_EDGE_FIT } from '../src/features/door.js';
import { computeDrawerFrontsPlacement, createDrawerFrontNodes, computeDrawerBoxPlacement, createDrawerBoxNodes, DEFAULT_DRAWER_EDGE_FIT } from '../src/features/drawer.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import { detectJoints, detectFeatureJoints, computeJointExtremities } from '../src/engine/joints.js';
import { readFileSync } from 'node:fs';
import { selectHingeHardware, selectPanelConnector, placeFastenersAlongSeam, formatHardwareTableRow, HINGE_CATALOG, PANEL_CONNECTOR_CATALOG } from '../src/engine/hardware.js';

await ensureMaterialCatalog();

// ---------------------------------------------------------------
// Hinge selection — real door fixture
// ---------------------------------------------------------------
section('selectHingeHardware — real door fixture', () => {
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

  const hingeJoint = detectFeatureJoints(panels)[0];
  assertEqual(hingeJoint.kind, 'door_hinge', 'fixture sanity: the feature joint is a door_hinge');
  assertEqual(hingeJoint.lengthMm, doorNode.height, 'fixture sanity: hinge line length equals the door height (700mm, a plain DEFAULT_BOX_HEIGHT_MM door)');

  const selection = selectHingeHardware(hingeJoint, doorNode.thickness);
  assert(selection !== null, 'selection: an 18mm door matches a catalog hinge (16-24mm range)');
  assertEqual(selection.hardware.brand, 'Blum', 'selection: hardware is attributed to Blum');
  assertEqual(selection.count, 2, '700mm-tall door (<=900mm threshold): 2 hinges');
});

section('selectHingeHardware — hinge count thresholds', () => {
  const line = (heightMm) => ({ kind: 'door_hinge', p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: heightMm, z: 0 }, lengthMm: heightMm });
  assertEqual(selectHingeHardware(line(700), 18).count, 2, '700mm door (<=900): 2 hinges');
  assertEqual(selectHingeHardware(line(900), 18).count, 2, '900mm door (boundary, <=900): 2 hinges');
  assertEqual(selectHingeHardware(line(901), 18).count, 3, '901mm door (>900): 3 hinges');
  assertEqual(selectHingeHardware(line(1600), 18).count, 3, '1600mm door (boundary, <=1600): 3 hinges');
  assertEqual(selectHingeHardware(line(1601), 18).count, 4, '1601mm door (>1600): 4 hinges');

  // Positions: always within the line, inset from both ends, monotonic along the line
  const sel = selectHingeHardware(line(700), 18);
  assertEqual(sel.positions.length, 2, 'positions: array length matches count');
  assert(sel.positions[0].y > 0 && sel.positions[0].y < 700, 'positions: first hinge strictly inside the line, not at the very corner');
  assert(sel.positions[1].y > sel.positions[0].y, 'positions: hinges are ordered along the line');
  assert(700 - sel.positions[1].y > 0, 'positions: last hinge is inset from the top end too, not flush with it');
  assertEqual(sel.positions[0].y, 700 - sel.positions[1].y, 'positions: symmetric inset from both ends for the 2-hinge case');

  // Out-of-range thickness -> no match, not a wrong guess
  assertEqual(selectHingeHardware(line(700), 8), null, 'selection: an 8mm door (too thin for any catalog hinge) returns null, not a forced match');
});

// ---------------------------------------------------------------
// Panel connectors — corner_butt / t_butt fasteners
// ---------------------------------------------------------------
section('selectPanelConnector — corner_butt / t_butt fasteners', () => {
  const { nodes: boxNodes } = addBox([]);
  const resolved = resolveConstraints(boxNodes);
  const { joints } = detectJoints(resolved);
  const leftTop = joints.find((j) => {
    const names = [resolved.find((r) => r.id === j.panelA).name, resolved.find((r) => r.id === j.panelB).name];
    return names.includes('Left') && names.includes('Top');
  });
  const extremities = computeJointExtremities(leftTop);

  const selection = selectPanelConnector(leftTop, extremities, 18);
  assert(selection !== null, 'selection: an 18mm corner_butt joint matches the generic connector');
  assertEqual(selection.hardware.brand, null, 'selection: panel connector is explicitly NOT attributed to Blum');
  assert(selection.positions.length >= 1, 'selection: at least one fastener position returned');

  // face_to_face and near_contact aren't fastener joints at all
  assertEqual(selectPanelConnector({ type: 'face_to_face' }, extremities, 18), null, 'selection: face_to_face returns null (glue/clamp, not discrete fasteners)');
  assertEqual(selectPanelConnector({ type: 'near_contact' }, extremities, 18), null, 'selection: near_contact returns null (not a real joint)');

  // Too thin for the catalog entry
  assertEqual(selectPanelConnector(leftTop, extremities, 10), null, 'selection: a 10mm panel (below minPanelThicknessMm) returns null');
});

// ---------------------------------------------------------------
// placeFastenersAlongSeam — spacing/edge-offset geometry, independent of any catalog
// ---------------------------------------------------------------
section('placeFastenersAlongSeam — spacing math', () => {
  const seam = { p1: { x: 0, y: 0, z: -200 }, p2: { x: 0, y: 0, z: 200 }, lengthMm: 400 };
  const positions = placeFastenersAlongSeam(seam, 50, 150);
  // usable = 400 - 100 = 300; gaps = ceil(300/150) = 2 -> 3 fasteners
  assertEqual(positions.length, 3, 'spacing: 400mm seam, 50mm edge offset, 150mm max spacing -> 3 fasteners');
  assert(Math.abs(positions[0].z - (-150)) < 1e-6, 'spacing: first fastener sits exactly at the edge offset from one end');
  assert(Math.abs(positions[2].z - 150) < 1e-6, 'spacing: last fastener sits exactly at the edge offset from the other end');
  assert(Math.abs(positions[1].z - 0) < 1e-6, 'spacing: middle fastener is evenly spaced (centered for a symmetric 3-fastener case)');
  for (let i = 1; i < positions.length; i++) {
    const gap = Math.hypot(positions[i].x - positions[i - 1].x, positions[i].y - positions[i - 1].y, positions[i].z - positions[i - 1].z);
    assert(gap <= 150 + 1e-6, `spacing: gap between fastener ${i - 1} and ${i} does not exceed maxSpacingMm`);
  }

  // A seam too short for even the two edge offsets -> single centered fastener, not a crash
  const tinySeam = { p1: { x: 0, y: 0, z: -10 }, p2: { x: 0, y: 0, z: 10 }, lengthMm: 20 };
  const tinyPositions = placeFastenersAlongSeam(tinySeam, 50, 150);
  assertEqual(tinyPositions.length, 1, 'spacing: seam shorter than 2x edge offset falls back to a single centered fastener');
  assertEqual(tinyPositions[0].z, 0, 'spacing: that single fastener sits at the seam\'s midpoint');
});

// ---------------------------------------------------------------
// Catalog data sanity — every entry has the fields selectors depend on
// ---------------------------------------------------------------
section('Catalog data sanity', () => {
  assert(HINGE_CATALOG.every((h) => h.cupDiameterMm === 35 && h.cupDepthMm === 13), 'catalog: every hinge entry uses the real Blum 35mm/13mm cup spec');
  assert(PANEL_CONNECTOR_CATALOG.every((c) => c.brand === null), 'catalog: every panel connector is explicitly marked non-Blum');
});

// ---------------------------------------------------------------
// formatHardwareTableRow — runner and fastener row shapes
// ---------------------------------------------------------------
section('formatHardwareTableRow — runner and fastener rows', () => {
  // entries as the API returns them (a real plan, exported from the API repo's fixtures)
  const plan = JSON.parse(readFileSync(new URL('../fixtures/api-steps/box_drawers_plinth.assembly.json', import.meta.url), 'utf8'));
  const entries = plan.steps.flatMap((st) => st.hardware);
  const runner = entries.find((h) => h.kind === 'runner');
  const fastener = entries.find((h) => h.kind === 'fastener');
  assert(runner && fastener, 'fixture has a runner and a fastener entry');
  const runnerRow = formatHardwareTableRow(runner);
  assertEqual(runnerRow.kind, 'runner', 'runner row: kind is runner');
  assertEqual(runnerRow.qty, '1', 'runner row: qty is always 1 (one runner per side)');
  assert(/^NL \d+mm$/.test(runnerRow.detail), 'runner row: detail shows the nominal length');

  const fastenerRow = formatHardwareTableRow(fastener);
  assertEqual(fastenerRow.kind, 'fastener', 'fastener row: kind is fastener');
  assert(Number(fastenerRow.qty) >= 1, 'fastener row: qty matches the number of fastener positions');
  assertEqual(fastenerRow.hardware, 'Generic confirmat_screw', 'fastener row: non-Blum hardware falls back to "Generic" + kind label');
});

report();

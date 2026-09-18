/**
 * tests/hardware.test.mjs
 *
 * Empirical test harness for engine/hardware.js — same convention as
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
import { selectHingeHardware, selectRunnerHardware, selectPanelConnector, placeFastenersAlongSeam, buildHardwarePlan, formatHardwareTableRow, HINGE_CATALOG, RUNNER_CATALOG, PANEL_CONNECTOR_CATALOG } from '../src/engine/hardware.js';

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
// Runner selection — real drawer fixture
// ---------------------------------------------------------------
section('selectRunnerHardware — real drawer fixture', () => {
  const { nodes: boxNodes } = addBox([]);
  const left = boxNodes.find((n) => n.name === 'Left');
  const right = boxNodes.find((n) => n.name === 'Right');
  const top = boxNodes.find((n) => n.name === 'Top');
  const bottom = boxNodes.find((n) => n.name === 'Bottom');
  const boundaryResult = computeBoundaryRectangle(boxNodes, [left, right, top, bottom]);
  const frontsPlacement = computeDrawerFrontsPlacement(boxNodes, boundaryResult, DEFAULT_DRAWER_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, count: 1 });
  const frontNodes = createDrawerFrontNodes(boxNodes, frontsPlacement, {});
  let panels = [...boxNodes];
  frontsPlacement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, frontsPlacement.normalAxis); });
  panels = [...panels, ...frontNodes];
  const boxPlacement = computeDrawerBoxPlacement(panels, frontNodes[0], { material: 'Melamine White 18mm', thicknessMm: 18 });
  const drawerBoxNodes = createDrawerBoxNodes(panels, boxPlacement);
  panels = [...panels, ...drawerBoxNodes];

  const resolved = resolveConstraints(panels);
  const boxLeftRaw = drawerBoxNodes.find((n) => n.drawerBoxRole === 'left');
  const boxLeftResolved = resolved.find((r) => r.id === boxLeftRaw.id);

  const slideJoint = detectFeatureJoints(panels).find((j) => j.panelA === boxLeftRaw.id);
  assertEqual(slideJoint.kind, 'drawer_slide', 'fixture sanity: feature joint is a drawer_slide');
  assert(Math.abs(slideJoint.lengthMm - boxLeftResolved.width) < 1e-6, 'fixture sanity: slide length equals the drawer box side\'s own depth extent');

  const selection = selectRunnerHardware(slideJoint, boxLeftRaw.thickness);
  assert(selection !== null, 'selection: a real drawer box side matches a catalog runner');
  assertEqual(selection.hardware.brand, 'Blum', 'selection: hardware is attributed to Blum');
  assert(selection.nominalLengthMm <= slideJoint.lengthMm, 'selection: chosen nominal length never exceeds the drawer box\'s actual depth');
  assert(selection.hardware.nominalLengthsMm.includes(selection.nominalLengthMm), 'selection: chosen length is a real catalog nominal length, not an arbitrary number');

  // Depth just barely too shallow for any catalog runner -> null
  const tinyJoint = { kind: 'drawer_slide', lengthMm: 100, p1: { x: 0, y: 0, z: -50 }, p2: { x: 0, y: 0, z: 50 } };
  assertEqual(selectRunnerHardware(tinyJoint, 16), null, 'selection: a drawer box shallower than the shortest catalog runner returns null');

  // Wood-side thickness outside TANDEM's range but present -> still matches (LEGRABOX doesn't care about wood thickness)
  const thickSideJoint = { kind: 'drawer_slide', lengthMm: 400, p1: { x: 0, y: 0, z: -200 }, p2: { x: 0, y: 0, z: 200 } };
  const thickSel = selectRunnerHardware(thickSideJoint, 25); // outside TANDEM's 11-16mm
  assert(thickSel !== null, 'selection: a drawer side too thick for TANDEM still gets a runner (LEGRABOX, not wood-thickness-gated)');
  assertEqual(thickSel.hardware.series, 'LEGRABOX', 'selection: falls through to LEGRABOX when TANDEM\'s thickness range is exceeded');

  // The real fixture's ACTUAL measured clearance must equal Blum's own
  // published 21mm spec — this is the number features/drawer.js's
  // DEFAULT_DRAWER_BOX_WIDTH_MARGIN_MM has to stay in sync with; a
  // regression here means the geometry and the hardware catalog have
  // drifted apart again.
  assert(Math.abs(slideJoint.clearanceMm - 21) < 1e-6, `fixture sanity: the real drawer box is built with exactly Blum's 21mm side clearance (got ${slideJoint.clearanceMm})`);
  RUNNER_CATALOG.forEach((r) => assertEqual(r.sideClearanceMm, 21, `catalog: ${r.series} publishes the same 21mm side clearance Blum specifies`));

  // A drawer box built with the WRONG margin (note: no clearanceMm field at
  // all on tinyJoint/thickSideJoint above means those two tests exercise the
  // "no measured clearance available" fallback path, not this check) must be
  // rejected outright rather than getting a runner recommended that doesn't
  // physically fit the gap actually built.
  const wrongMarginJoint = { kind: 'drawer_slide', lengthMm: 400, clearanceMm: 13, p1: { x: 0, y: 0, z: -200 }, p2: { x: 0, y: 0, z: 200 } };
  assertEqual(selectRunnerHardware(wrongMarginJoint, 16), null, 'selection: a built clearance of 13mm (the old, wrong default) matches no catalog runner\'s 21mm spec, and is correctly rejected');

  // A clearance that DOES match (within floating-point tolerance) is accepted
  const rightMarginJoint = { kind: 'drawer_slide', lengthMm: 400, clearanceMm: 21.2, p1: { x: 0, y: 0, z: -200 }, p2: { x: 0, y: 0, z: 200 } };
  assert(selectRunnerHardware(rightMarginJoint, 16) !== null, 'selection: a clearance within tolerance of the 21mm spec (21.2mm) is still accepted');
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
  assert(RUNNER_CATALOG.every((r) => Array.isArray(r.nominalLengthsMm) && r.nominalLengthsMm.length > 0), 'catalog: every runner entry has at least one nominal length');
  assert(PANEL_CONNECTOR_CATALOG.every((c) => c.brand === null), 'catalog: every panel connector is explicitly marked non-Blum');
});

// ---------------------------------------------------------------
// buildHardwarePlan — ties detectJoints + detectFeatureJoints + this
// file's selectors into one pass, on a real door + drawer + box design
// ---------------------------------------------------------------
let combinedFixture;
section('buildHardwarePlan — combined door + drawer + box fixture', () => {
  const { nodes: boxNodes } = addBox([]);
  const left = boxNodes.find((n) => n.name === 'Left');
  const right = boxNodes.find((n) => n.name === 'Right');
  const top = boxNodes.find((n) => n.name === 'Top');
  const bottom = boxNodes.find((n) => n.name === 'Bottom');
  const boundaryResult = computeBoundaryRectangle(boxNodes, [left, right, top, bottom]);

  // A door on this box would occupy the same Back/Front opening a
  // drawer front does, so this fixture builds the drawer only (a
  // door+drawer-on-the-same-box combination isn't a real construction
  // — see boundaryIds' single-opening model) and covers the door path
  // with its own dedicated fixture above instead.
  const frontsPlacement = computeDrawerFrontsPlacement(boxNodes, boundaryResult, DEFAULT_DRAWER_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, count: 1 });
  const frontNodes = createDrawerFrontNodes(boxNodes, frontsPlacement, {});
  let panels = [...boxNodes];
  frontsPlacement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, frontsPlacement.normalAxis); });
  panels = [...panels, ...frontNodes];
  const boxPlacement = computeDrawerBoxPlacement(panels, frontNodes[0], { material: 'Melamine White 18mm', thicknessMm: 18 });
  const drawerBoxNodes = createDrawerBoxNodes(panels, boxPlacement);
  panels = [...panels, ...drawerBoxNodes];
  combinedFixture = panels;

  const plan = buildHardwarePlan(panels);

  assertEqual(plan.summary.hingeCount, 0, 'plan: no hinges (this fixture has no door)');
  assertEqual(plan.summary.runnerCount, 2, 'plan: 2 runners (drawer box left + right)');
  assertEqual(plan.summary.totalHingeUnits, 0, 'plan: totalHingeUnits is 0 alongside hingeCount 0');
  assert(plan.summary.fastenerJointCount > 0, 'plan: at least one corner_butt/t_butt fastener recommendation from the plain box carcass');
  assert(plan.summary.totalFastenerCount >= plan.summary.fastenerJointCount, 'plan: totalFastenerCount is at least one fastener per fastener joint');
  assertEqual(plan.summary.unmatchedCount, 0, 'plan: nothing unmatched for a normal 18mm design');

  assert(plan.runners.every((r) => /^RN\d{3}$/.test(r.displayId)), 'plan: runners get RN### display ids');
  assert(plan.fasteners.every((f) => /^FS\d{3}$/.test(f.displayId)), 'plan: fasteners get FS### display ids');
  assert(plan.runners.every((r) => r.panelACode && r.panelBCode), 'plan: runners carry panel codes');
  assert(plan.fasteners.every((f) => f.jointId && f.jointType), 'plan: fastener entries carry back-reference to the originating joint');

  const leftRunner = plan.runners.find((r) => r.panelBCode === left.pieceCode);
  assert(!!leftRunner, 'plan: a runner is associated with the carcass Left panel specifically');
  assertEqual(leftRunner.hardware.brand, 'Blum', 'plan: runner hardware is Blum-attributed');
});

// ---------------------------------------------------------------
// buildHardwarePlan — a design with a door, for hinge coverage
// ---------------------------------------------------------------
section('buildHardwarePlan — door fixture', () => {
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

  const plan = buildHardwarePlan(panels);
  assertEqual(plan.summary.hingeCount, 1, 'door plan: exactly 1 hinge feature joint');
  assertEqual(plan.summary.runnerCount, 0, 'door plan: no runners (no drawer)');
  assertEqual(plan.summary.totalHingeUnits, 2, 'door plan: a 700mm door needs 2 physical hinge units');
  assertEqual(plan.hinges[0].panelBCode, left.pieceCode, 'door plan: hinge associates with the Left panel (hinge:\'left\')');

  const row = formatHardwareTableRow(plan.hinges[0]);
  assertEqual(row.id, 'HG001', 'hardware table row: hinge id matches HG001');
  assertEqual(row.kind, 'hinge', 'hardware table row: kind is hinge');
  assertEqual(row.hardware, 'Blum CLIP top BLUMOTION', 'hardware table row: hardware label combines brand + series');
  assertEqual(row.qty, '2', 'hardware table row: qty matches the 2-hinge count');
  assert(row.detail.startsWith('Y:'), 'hardware table row: detail compacts to the single varying axis (Y) for a hinge set');
});

// ---------------------------------------------------------------
// formatHardwareTableRow — runner and fastener row shapes
// ---------------------------------------------------------------
section('formatHardwareTableRow — runner and fastener rows', () => {
  const plan = buildHardwarePlan(combinedFixture);
  const runnerRow = formatHardwareTableRow(plan.runners[0]);
  assertEqual(runnerRow.kind, 'runner', 'runner row: kind is runner');
  assertEqual(runnerRow.qty, '1', 'runner row: qty is always 1 (one runner per side)');
  assert(/^NL \d+mm$/.test(runnerRow.detail), 'runner row: detail shows the nominal length');

  const fastenerRow = formatHardwareTableRow(plan.fasteners[0]);
  assertEqual(fastenerRow.kind, 'fastener', 'fastener row: kind is fastener');
  assert(Number(fastenerRow.qty) >= 1, 'fastener row: qty matches the number of fastener positions');
  assertEqual(fastenerRow.hardware, 'Generic confirmat_screw', 'fastener row: non-Blum hardware falls back to "Generic" + kind label');
});

report();

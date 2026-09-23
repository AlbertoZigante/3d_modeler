/**
 * tests/validator.test.mjs
 *
 * Empirical test harness for engine/validator.js — asserts on the
 * REAL addBox()/resolveConstraints() output and hand-built synthetic
 * fixtures for the violation types that don't arise from the normal
 * feature set (collision, undersized/oversized panel, exceeded design
 * limit), same convention as tests/joints.test.mjs.
 *
 * Run with: node tests/validator.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { createPanelNode, MIN_PANEL_DIM_MM } from '../src/modeller/modules.js';
import { addBox } from '../src/features/box.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import { validateDesign } from '../src/engine/validator.js';

await ensureMaterialCatalog();

// ---------------------------------------------------------------
// Phase 1 — a plain, valid box has zero violations
// ---------------------------------------------------------------
section('Phase 1 — plain box: zero violations', () => {
  const { nodes } = addBox([]);
  const resolved = resolveConstraints(nodes);
  const { violations } = validateDesign(nodes, resolved);
  assertEqual(violations.length, 0, 'plain box produces zero violations of any type');
});

// ---------------------------------------------------------------
// Phase 2 — interpenetration -> collision violation
// (same synthetic fixture as tests/joints.test.mjs's own Phase 4,
// asserting here on validateDesign's own violation wrapping rather
// than detectJoints's raw collisions array)
// ---------------------------------------------------------------
section('Phase 2 — interpenetration -> collision violation', () => {
  const a = createPanelNode({ name: 'A', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  const b = createPanelNode({ name: 'B', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  a.basePosition = { x: 0, y: 0, z: 0 };
  b.basePosition = { x: 0, y: 0, z: 5 }; // deliberately overlapping on X, Y, AND Z at once
  const resolved = resolveConstraints([a, b]);
  const { violations } = validateDesign([a, b], resolved);

  const collisions = violations.filter((v) => v.type === 'collision');
  assertEqual(collisions.length, 1, 'exactly one collision violation');
  assert(collisions[0].message.includes('A') && collisions[0].message.includes('B'), 'collision message names both panels');
});

// ---------------------------------------------------------------
// Phase 3 — a panel below MIN_PANEL_DIM_MM -> undersizedPanel
// ---------------------------------------------------------------
section('Phase 3 — undersized panel', () => {
  const tiny = createPanelNode({ name: 'Tiny', width: 5, height: 500, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  tiny.basePosition = { x: 0, y: 0, z: 0 };
  const resolved = resolveConstraints([tiny]);
  const { violations } = validateDesign([tiny], resolved);

  const undersized = violations.filter((v) => v.type === 'undersizedPanel');
  assertEqual(undersized.length, 1, 'exactly one undersized violation');
  assert(undersized[0].panelIds.includes(tiny.id), 'violation references the offending panel id');
  assert(undersized[0].message.includes(String(MIN_PANEL_DIM_MM)), 'message cites the actual configured minimum');
});

// ---------------------------------------------------------------
// Phase 4 — a panel above PANEL_SIZE_LIMITS_MM -> oversizedPanel
// ---------------------------------------------------------------
section('Phase 4 — oversized panel', () => {
  const huge = createPanelNode({ name: 'Huge', width: 2000, height: 500, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  huge.basePosition = { x: 0, y: 0, z: 0 };
  const resolved = resolveConstraints([huge]);
  const { violations } = validateDesign([huge], resolved);

  const oversized = violations.filter((v) => v.type === 'oversizedPanel');
  assertEqual(oversized.length, 1, 'exactly one oversized violation');
  assert(oversized[0].message.includes('width'), 'message identifies width as the offending field');
});

// ---------------------------------------------------------------
// Phase 5 — a panel positioned past DESIGN_LIMITS_MM.y.max ->
// exceedsDesignLimit ("too tall furniture")
// ---------------------------------------------------------------
section('Phase 5 — exceeds overall design height limit', () => {
  const tall = createPanelNode({ name: 'TallPanel', width: 500, height: 500, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  tall.basePosition = { x: 0, y: 3200, z: 0 }; // past FLOOR_MM + 3000
  const resolved = resolveConstraints([tall]);
  const { violations } = validateDesign([tall], resolved);

  const exceeded = violations.filter((v) => v.type === 'exceedsDesignLimit');
  assertEqual(exceeded.length, 1, 'exactly one design-limit violation');
  assert(exceeded[0].message.includes('height'), 'message identifies height (the y axis) as the exceeded limit');
});

// ---------------------------------------------------------------
// Phase 6 — precomputed collisions are honored, not silently
// recomputed (this is what lets modeller-main.js share ONE
// detectJoints() call between checkJointWarnings and validateDesign)
// ---------------------------------------------------------------
section('Phase 6 — precomputed collisions are reused as-is', () => {
  const { nodes } = addBox([]);
  const resolved = resolveConstraints(nodes);
  const { violations } = validateDesign(nodes, resolved, { collisions: [] });
  assertEqual(violations.filter((v) => v.type === 'collision').length, 0, 'an explicitly empty collisions array is trusted, not recomputed');
});

report();

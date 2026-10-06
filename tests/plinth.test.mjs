/**
 * tests/plinth.test.mjs
 *
 * Covers features/plinth.js: building a 4-panel (left/right/back/
 * front) open frame flush under an existing box's own Bottom panel,
 * the default/custom height, the real-clearance-free "flush with the
 * Bottom panel's own footprint" geometry (no outward overshoot), and
 * applyPlinthAdjustment's in-place height recompute. Same real-fixture
 * convention as tests/drawer.test.mjs.
 *
 * Run with: node tests/plinth.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { addBox } from '../src/features/box.js';
import {
  computePlinthPlacement,
  createPlinthNodes,
  applyPlinthAdjustment,
  DEFAULT_PLINTH_HEIGHT_MM,
  MIN_PLINTH_HEIGHT_MM,
} from '../src/features/plinth.js';
import { resolveConstraints } from '../src/modeller/snap.js';

await ensureMaterialCatalog();

function buildBoxWithPlinth(heightMm) {
  const { nodes: boxNodes, groupId } = addBox([]);
  const placement = computePlinthPlacement(boxNodes, groupId, heightMm != null ? { heightMm } : {});
  const plinthNodes = placement.ok ? createPlinthNodes(boxNodes, placement) : [];
  return { panels: [...boxNodes, ...plinthNodes], groupId, placement, plinthNodes };
}

function byRole(plinthNodes, role) {
  return plinthNodes.find((n) => n.plinthRole === role);
}

// ---------------------------------------------------------------
// Placement — default height, flush footprint
// ---------------------------------------------------------------
section('computePlinthPlacement — default height, flush under the Bottom panel', () => {
  const { nodes: boxNodes, groupId } = addBox([]);
  const placement = computePlinthPlacement(boxNodes, groupId, {});
  assert(placement.ok, 'placement succeeds on a plain, freshly-added box');
  assertEqual(placement.heightMm, DEFAULT_PLINTH_HEIGHT_MM, 'defaults to DEFAULT_PLINTH_HEIGHT_MM (60mm) when no heightMm is given');

  const bottomRaw = boxNodes.find((p) => p.name === 'Bottom');
  const resolved = resolveConstraints(boxNodes);
  const bottom = resolved.find((r) => r.id === bottomRaw.id);
  const bottomUndersideY = bottom.position.y - bottom.thickness / 2;

  const left = placement.left;
  assert(Math.abs((left.center.y + left.dims.height / 2) - bottomUndersideY) < 1e-6, 'left panel\'s own top edge is exactly flush with the Bottom panel\'s underside');
  assert(Math.abs((left.center.y - left.dims.height / 2) - (bottomUndersideY - DEFAULT_PLINTH_HEIGHT_MM)) < 1e-6, 'left panel\'s own bottom edge sits exactly heightMm below that');

  // Flush footprint: left/right run the FULL depth (back/front sit
  // inset between them — DEFAULT_EDGE_FIT, not the carcass's own
  // outward 'out' Back), and the overall outer footprint matches the
  // Bottom panel's own W x D exactly, no overshoot.
  assertEqual(placement.left.dims.width, bottom.height, 'left/right\'s own width (their depth span) matches the Bottom panel\'s own depth exactly');
  const outerLeftX = placement.left.center.x - placement.left.dims.thickness / 2;
  const outerRightX = placement.right.center.x + placement.right.dims.thickness / 2;
  assert(Math.abs(outerLeftX - (bottom.position.x - bottom.width / 2)) < 1e-6, 'left panel\'s own outer face sits exactly at the Bottom panel\'s own outer edge (no overshoot)');
  assert(Math.abs(outerRightX - (bottom.position.x + bottom.width / 2)) < 1e-6, 'right panel\'s own outer face sits exactly at the Bottom panel\'s own other outer edge');
});

section('computePlinthPlacement — a custom height is honored exactly', () => {
  const { nodes: boxNodes, groupId } = addBox([]);
  const placement = computePlinthPlacement(boxNodes, groupId, { heightMm: 120 });
  assert(placement.ok, 'placement succeeds');
  assertEqual(placement.heightMm, 120, 'the requested height is used as-is (above the floor)');
  assertEqual(placement.left.dims.height, 120, 'left panel\'s own height matches the requested plinth height');
});

section('computePlinthPlacement — a height below the floor is clamped up', () => {
  const { nodes: boxNodes, groupId } = addBox([]);
  const placement = computePlinthPlacement(boxNodes, groupId, { heightMm: 0.1 });
  assert(placement.ok, 'placement still succeeds');
  assertEqual(placement.heightMm, MIN_PLINTH_HEIGHT_MM, 'a height below MIN_PLINTH_HEIGHT_MM is clamped up to the floor, not rejected or used as-is');
});

section('computePlinthPlacement — no Bottom panel in the group is refused', () => {
  const violations = computePlinthPlacement([], 'nonexistent-group', {});
  assertEqual(violations.ok, false, 'no panels at all -> refused');
  assertEqual(violations.reason, 'no-bottom-panel', 'reason names exactly what is missing');
});

// ---------------------------------------------------------------
// Node creation — groupId, basePosition, locking
// ---------------------------------------------------------------
section('createPlinthNodes — joins the owning box\'s own group and basePosition, all 4 roles present', () => {
  const { nodes: boxNodes, groupId } = addBox([]);
  const placement = computePlinthPlacement(boxNodes, groupId, {});
  const plinthNodes = createPlinthNodes(boxNodes, placement);

  assertEqual(plinthNodes.length, 4, 'exactly 4 panels — left, right, back, front');
  ['left', 'right', 'back', 'front'].forEach((role) => {
    const node = byRole(plinthNodes, role);
    assert(node, `a ${role} panel exists`);
    assertEqual(node.groupId, groupId, `${role} panel joins the owning box's own groupId, not a new one of its own`);
    assertEqual(node.isPlinthPanel, true, `${role} panel is tagged isPlinthPanel`);
    assertEqual(node.lockedMoveAxes.length, 3, `${role} panel has all 3 move axes locked (derived geometry, not hand-dragged)`);
  });

  const bottomRaw = boxNodes.find((p) => p.name === 'Bottom');
  assertEqual(JSON.stringify(byRole(plinthNodes, 'left').basePosition), JSON.stringify(bottomRaw.basePosition), 'plinth panels reuse the owning box\'s own existing basePosition, not {0,0,0} — so a group-drag of the box still carries the plinth along');
});

section('createPlinthNodes — resolves without collision against the box\'s own walls', () => {
  const { panels } = buildBoxWithPlinth();
  const resolved = resolveConstraints(panels);
  assertEqual(resolved.length, panels.length, 'every panel (box walls + plinth) resolves');
  // Sanity: the plinth sits strictly BELOW the box's own Bottom panel,
  // not overlapping it.
  const bottomRaw = panels.find((p) => p.name === 'Bottom');
  const bottom = resolved.find((r) => r.id === bottomRaw.id);
  const leftRaw = panels.find((p) => p.isPlinthPanel && p.plinthRole === 'left');
  const left = resolved.find((r) => r.id === leftRaw.id);
  assert((left.position.y + left.height / 2) <= (bottom.position.y - bottom.thickness / 2) + 1e-6, 'the plinth\'s own top edge never sits above the Bottom panel\'s underside');
});

// ---------------------------------------------------------------
// applyPlinthAdjustment — height field recompute
// ---------------------------------------------------------------
section('applyPlinthAdjustment — changes height in place, keeps the same 4 panel ids', () => {
  const { panels, plinthNodes } = buildBoxWithPlinth();
  const idsBefore = plinthNodes.map((n) => n.id).sort();

  const updated = applyPlinthAdjustment(panels, plinthNodes[0].groupId, 150);
  const updatedPlinth = updated.filter((p) => p.isPlinthPanel);
  const idsAfter = updatedPlinth.map((n) => n.id).sort();

  assertEqual(idsAfter.join(','), idsBefore.join(','), 'the same 4 node ids persist across a height change — this is a patch, not a replace (selection/history keep working)');
  updatedPlinth.forEach((p) => assertEqual(p.height, 150, 'every one of the 4 panels picks up the new height'));

  const resolved = resolveConstraints(updated);
  const bottomRaw = panels.find((p) => p.name === 'Bottom');
  const bottom = resolved.find((r) => r.id === bottomRaw.id);
  const left = resolved.find((r) => r.id === updatedPlinth.find((p) => p.plinthRole === 'left').id);
  assert(Math.abs((left.position.y + left.height / 2) - (bottom.position.y - bottom.thickness / 2)) < 1e-6, 'after the height change, the plinth\'s own top edge is STILL exactly flush with the Bottom panel\'s underside');
});

section('applyPlinthAdjustment — a group with no plinth is a no-op', () => {
  const { nodes: boxNodes, groupId } = addBox([]);
  const result = applyPlinthAdjustment(boxNodes, groupId, 100);
  assertEqual(result, boxNodes, 'returns the exact same array reference when this group has no plinth panels at all');
});

report();

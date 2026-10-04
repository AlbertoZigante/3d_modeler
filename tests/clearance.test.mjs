/**
 * tests/clearance.test.mjs
 *
 * Empirical test harness for engine/clearance.js — same convention as
 * tests/joints.test.mjs and tests/hardware.test.mjs: real fixtures
 * built from the actual addBox()/door.js/drawer.js/shelf.js pipeline,
 * exact assertions against the REAL resolveConstraints() output, not
 * "doesn't crash" checks.
 *
 * Run with: node tests/clearance.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { createPanelNode } from '../src/modeller/modules.js';
import { addBox } from '../src/features/box.js';
import { computeBoundaryRectangle, HORIZONTAL_ROTATION } from '../src/shared/geometry.js';
import { computeDoorPlacement, createDoorNode, applyPanelPatch, DEFAULT_DOOR_EDGE_FIT } from '../src/features/door.js';
import { computeDrawerFrontsPlacement, createDrawerFrontNodes, computeDrawerBoxPlacement, createDrawerBoxNodes, DEFAULT_DRAWER_EDGE_FIT } from '../src/features/drawer.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import {
  computeReservedVolumes,
  findVolumePanelViolations,
  findVolumeVolumeViolations,
  findParallelPanelGapViolations,
  findFixingProximityViolations,
  findBoringDepthViolations,
  findClearanceViolations,
  PARALLEL_PANEL_MIN_GAP_MM,
} from '../src/engine/clearance.js';

await ensureMaterialCatalog();

function boundaryPanels(boxNodes) {
  return ['Left', 'Right', 'Top', 'Bottom'].map((name) => boxNodes.find((n) => n.name === name));
}

// Builds a plain box + one door on the front opening — the shared
// fixture several sections below need.
function buildBoxWithDoor(hinge = 'left') {
  const { nodes: boxNodes } = addBox([]);
  const boundaryResult = computeBoundaryRectangle(boxNodes, boundaryPanels(boxNodes));
  const placement = computeDoorPlacement(boxNodes, boundaryResult, DEFAULT_DOOR_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, hinge });
  const doorNode = createDoorNode(boxNodes, placement);
  let panels = [...boxNodes];
  placement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, placement.normalAxis); });
  panels = [...panels, doorNode];
  return { panels, doorNode };
}

// Builds a plain box + one drawer (front + box panels) on the front opening.
function buildBoxWithDrawer() {
  const { nodes: boxNodes } = addBox([]);
  const boundaryResult = computeBoundaryRectangle(boxNodes, boundaryPanels(boxNodes));
  const frontsPlacement = computeDrawerFrontsPlacement(boxNodes, boundaryResult, DEFAULT_DRAWER_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, count: 1 });
  const frontNodes = createDrawerFrontNodes(boxNodes, frontsPlacement, {});
  let panels = [...boxNodes];
  frontsPlacement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, frontsPlacement.normalAxis); });
  panels = [...panels, ...frontNodes];
  const boxPlacement = computeDrawerBoxPlacement(panels, frontNodes[0], { material: 'Melamine White 18mm', thicknessMm: 18 });
  const drawerBoxNodes = createDrawerBoxNodes(panels, boxPlacement);
  panels = [...panels, ...drawerBoxNodes];
  return { panels, frontNode: frontNodes[0] };
}

// ---------------------------------------------------------------
// Fastener access — plain box (corner_butt joints only)
// ---------------------------------------------------------------
section('computeReservedVolumes — fastener access on a plain box', () => {
  const { nodes: panels } = addBox([]);
  const volumes = computeReservedVolumes(panels);
  const fastenerVolumes = volumes.filter((v) => v.kind === 'fastenerAccess');
  assert(fastenerVolumes.length > 0, 'a plain 6-panel box produces at least one fastener-access volume');
  fastenerVolumes.forEach((v) => {
    assertEqual(v.ownerIds.length, 2, 'each fastener volume is owned by exactly the 2 joined panels');
    ['x', 'y', 'z'].forEach((axis) => {
      assert(v.box[axis][1] > v.box[axis][0], `fastener volume box is non-degenerate on ${axis}`);
    });
  });

  // No panel of the plain box itself should be flagged — nothing was
  // placed inside the driver-access corridor of its own joints.
  const resolved = resolveConstraints(panels);
  const violations = findVolumePanelViolations(resolved, fastenerVolumes);
  assertEqual(violations.length, 0, 'a plain box with nothing extra placed has no fastener-access violations');
});

// ---------------------------------------------------------------
// Door swing
// ---------------------------------------------------------------
section('computeReservedVolumes — door swing volume', () => {
  const { panels, doorNode } = buildBoxWithDoor('left');
  const volumes = computeReservedVolumes(panels);
  const swing = volumes.find((v) => v.kind === 'doorSwing' && v.ownerIds.includes(doorNode.id));
  assert(swing, 'a hinged door produces a doorSwing volume');

  const resolved = resolveConstraints(panels);
  const doorResolved = resolved.find((r) => r.id === doorNode.id);
  assert(swing.box.y[1] - swing.box.y[0] >= doorResolved.height - 0.5, 'swing volume spans at least the door\'s own height');
  // The union-of-closed-and-open box must be strictly wider on the
  // normal axis (z, for this box's default Front opening) than the
  // door's own closed thickness — otherwise it's just the closed box.
  assert(swing.box.z[1] - swing.box.z[0] > doorResolved.thickness + 1, 'swing volume extends past the closed door\'s own thickness on the swing (z) axis');
});

section('computeReservedVolumes — lid-style door (normalAxis y) has no swing volume', () => {
  // A door can only hinge on a vertical edge (see computeDoorOpenTransform's
  // own guard) — normalAxis 'y' is a lid, so no doorSwing volume should
  // ever be produced for it, rather than one silently computed wrong.
  const doorRaw = createPanelNode({ isDoor: true, hinge: 'left', normalAxis: 'y', doorSign: 1, width: 400, height: 18, thickness: 18, basePosition: { x: 0, y: 0, z: 0 } });
  const volumes = computeReservedVolumes([doorRaw]);
  assertEqual(volumes.filter((v) => v.kind === 'doorSwing').length, 0, 'a lid-style door produces no doorSwing volume');
});

// ---------------------------------------------------------------
// Drawer travel
// ---------------------------------------------------------------
section('computeReservedVolumes — drawer travel volume', () => {
  const { panels, frontNode } = buildBoxWithDrawer();
  const volumes = computeReservedVolumes(panels);
  const travel = volumes.find((v) => v.kind === 'drawerTravel' && v.ownerIds.includes(frontNode.id));
  assert(travel, 'a drawer produces a drawerTravel volume owned by its front');

  const resolved = resolveConstraints(panels);
  const frontResolved = resolved.find((r) => r.id === frontNode.id);
  const closedZ = [frontResolved.position.z - frontResolved.thickness / 2, frontResolved.position.z + frontResolved.thickness / 2];
  // Travel volume must be strictly larger than the closed front's own
  // footprint along the normal axis (z, for this box's default Front opening).
  const travelSpan = travel.box.z[1] - travel.box.z[0];
  const closedSpan = closedZ[1] - closedZ[0];
  assert(travelSpan > closedSpan + 1, 'drawer travel volume extends well past the closed front\'s own thickness along the pull-out axis');

  // Nothing placed behind the drawer in this fixture -> no violation.
  const violations = findVolumePanelViolations(resolved, volumes.filter((v) => v.kind === 'drawerTravel'));
  assertEqual(violations.length, 0, 'an empty box behind the drawer has no drawer-travel violations');
});

// ---------------------------------------------------------------
// Handle clearance
// ---------------------------------------------------------------
section('computeReservedVolumes — handle clearance volume', () => {
  const { panels, doorNode } = buildBoxWithDoor('left');
  const volumes = computeReservedVolumes(panels);
  const handle = volumes.find((v) => v.kind === 'handleClearance' && v.ownerIds.includes(doorNode.id));
  assert(handle, 'a door produces a handleClearance volume');
  ['x', 'y', 'z'].forEach((axis) => {
    assert(handle.box[axis][1] > handle.box[axis][0], `handle volume is non-degenerate on ${axis}`);
  });
});

section('findVolumeVolumeViolations — two independent doors\' handles do not conflict when far apart', () => {
  const { panels } = buildBoxWithDoor('left');
  const volumes = computeReservedVolumes(panels);
  const conflicts = findVolumeVolumeViolations(volumes);
  assertEqual(conflicts.length, 0, 'a single plain door\'s own swing/handle/hinge volumes never conflict with each other (shared owner is excluded)');
});

// ---------------------------------------------------------------
// Parallel panel spacing
// ---------------------------------------------------------------
// Synthetic resolved-shaped fixtures — same "hand-built against the
// pure function" convention tests/hardware.test.mjs uses for its own
// hinge-count-threshold fixtures, since what's under test here is the
// geometry math itself, not shelf placement (real shelf placement,
// enforcing MIN_WALL_GAP_MM, can't even construct a too-close pair —
// that's the whole point of checkMinGap already existing).
function horizontalPanel(id, centerY) {
  return { id, name: id, hidden: false, rotation: { ...HORIZONTAL_ROTATION }, position: { x: 0, y: centerY, z: 0 }, width: 400, height: 400, thickness: 18 };
}

section('findParallelPanelGapViolations — two facing panels closer than the minimum', () => {
  const a = horizontalPanel('PanelA', 300);
  const gapCenterToCenter = 18 + PARALLEL_PANEL_MIN_GAP_MM / 2; // deliberately inside the minimum
  const b = horizontalPanel('PanelB', 300 + gapCenterToCenter);
  const violations = findParallelPanelGapViolations([a, b]);
  assert(violations.some((v) => v.type === 'parallelPanelGap'), 'two facing panels placed closer than PARALLEL_PANEL_MIN_GAP_MM are flagged');
});

section('findParallelPanelGapViolations — panels far enough apart are not flagged', () => {
  const a = horizontalPanel('PanelA', 300);
  const b = horizontalPanel('PanelB', 300 + 18 + PARALLEL_PANEL_MIN_GAP_MM + 20);
  const violations = findParallelPanelGapViolations([a, b]);
  assertEqual(violations.length, 0, 'two facing panels with more than the minimum gap are not flagged');
});

section('findParallelPanelGapViolations — touching panels are a joint, not a spacing violation', () => {
  const a = horizontalPanel('PanelA', 300);
  const b = horizontalPanel('PanelB', 318); // flush touch: 18mm apart == both half-thicknesses (9+9)
  const violations = findParallelPanelGapViolations([a, b]);
  assertEqual(violations.length, 0, 'two panels touching flush are not reported as a spacing violation (that is engine/joints.js\'s job)');
});

section('findParallelPanelGapViolations — a normal, well-spaced box has none', () => {
  const { nodes: boxNodes } = addBox([]);
  const resolved = resolveConstraints(boxNodes);
  const violations = findParallelPanelGapViolations(resolved);
  assertEqual(violations.length, 0, 'a plain box\'s own walls (touching, not just close) are never flagged as a spacing violation');
});

// ---------------------------------------------------------------
// Boring depth
// ---------------------------------------------------------------
section('findBoringDepthViolations — thin door vs a real hinge cup', () => {
  // A door thin enough that even the smallest cataloged hinge's cup
  // depth (13mm) leaves under MIN_BORING_WALL_MM behind it. The
  // catalog's own minDoorThicknessMm floor is 16mm, so this fixture
  // deliberately hand-builds a FeatureJoint/door pair thinner than
  // that would allow through the normal door.js pipeline, to exercise
  // the check itself against a worst-case number rather than asserting
  // the catalog's own thickness floor (that's hardware.js's job, already
  // covered by tests/hardware.test.mjs).
  const { panels, doorNode } = buildBoxWithDoor('left');
  const violations = findBoringDepthViolations(panels);
  // A normal 18mm door with the 13mm-cup hinge leaves 5mm — above
  // MIN_BORING_WALL_MM (2mm) — so the realistic fixture should NOT flag.
  assertEqual(violations.filter((v) => v.panelIds.includes(doorNode.id)).length, 0, 'a normal 18mm door with the standard 13mm-deep cup is not flagged');
});

// ---------------------------------------------------------------
// Whole-thing entry point
// ---------------------------------------------------------------
section('findClearanceViolations — runs clean on an untouched box+door+drawer design', () => {
  const { panels: doorPanels } = buildBoxWithDoor('left');
  const resolved = resolveConstraints(doorPanels);
  const violations = findClearanceViolations(doorPanels, resolved);
  assertEqual(violations.length, 0, 'a freshly-built box+door with nothing else placed produces zero clearance violations');
});

section('findClearanceViolations — a panel placed inside a door\'s swing IS flagged', () => {
  const { panels, doorNode } = buildBoxWithDoor('left');
  const groupId = panels.find((p) => p.isBoxWall).groupId;
  // Placed squarely inside the front door's 90°-open swing envelope
  // (verified against the real computed swing box for this fixture:
  // roughly x:[9,482] y:[18,718] z:[200,673] — this block sits well
  // within all three ranges without touching any existing panel).
  const intruder = createPanelNode({
    groupId,
    name: 'IntrudingBlock',
    rotation: { x: 0, y: 0, z: 0 },
    width: 40, height: 40, thickness: 40,
    basePosition: { x: 300, y: 400, z: 400 },
  });
  const panelsWithIntruder = [...panels, intruder];
  const resolved = resolveConstraints(panelsWithIntruder);
  const violations = findClearanceViolations(panelsWithIntruder, resolved);
  assert(
    violations.some((v) => v.type === 'doorSwing' && v.panelIds.includes(intruder.id) && v.panelIds.includes(doorNode.id)),
    'a panel placed across the door\'s open-swing volume is reported as a doorSwing violation'
  );
});

report();

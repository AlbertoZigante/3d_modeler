/**
 * tests/drawer.test.mjs
 *
 * Covers features/drawer.js#computeDrawerBoxPlacement's top/bottom
 * margin behavior: the default inset from the front's own top/bottom
 * edges, the floor that keeps a caller from reducing either margin
 * below that default, and the real-clearance guard against the
 * carcass Top/Bottom panels' own inner faces (not just the margin
 * arithmetic against the front). Same real-fixture convention as
 * tests/hardware.test.mjs and tests/clearance.test.mjs.
 *
 * Run with: node tests/drawer.test.mjs
 */
import { addPlinthAndRaiseBox } from '../src/features/plinth.js';
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { addBox } from '../src/features/box.js';
import { computeBoundaryRectangle } from '../src/shared/geometry.js';
import {
  computeDrawerFrontsPlacement,
  createDrawerFrontNodes,
  computeDrawerBoxPlacement,
  createDrawerBoxNodes,
  computeDrawerOpenTransform,
  DEFAULT_DRAWER_EDGE_FIT,
  DEFAULT_DRAWER_BOX_TOP_MARGIN_MM,
  DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM,
  DRAWER_OPEN_FRACTION,
  MIN_DRAWER_BOX_CLEARANCE_MM,
} from '../src/features/drawer.js';
import { applyPanelPatch } from '../src/features/door.js';
import { dimFieldForAxis } from '../src/shared/frontFit.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import { applyDrawerAdjustmentsForGroup, boxGroupOf, applyDrawerLayout } from '../src/features/drawer.js';
import { relayoutBox } from '../src/features/box.js';

await ensureMaterialCatalog();

const BOX_SPEC = { material: 'Melamine White 18mm', thicknessMm: 12 };

function boundaryPanels(boxNodes) {
  return ['Left', 'Right', 'Top', 'Bottom'].map((name) => boxNodes.find((n) => n.name === name));
}

// A plain box + one drawer front, flush ('in') on every edge — the
// shared fixture every section below builds on.
function buildBoxWithDrawerFront() {
  const { nodes: boxNodes } = addBox([]);
  const boundaryResult = computeBoundaryRectangle(boxNodes, boundaryPanels(boxNodes));
  const frontsPlacement = computeDrawerFrontsPlacement(boxNodes, boundaryResult, DEFAULT_DRAWER_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, count: 1 });
  const frontNodes = createDrawerFrontNodes(boxNodes, frontsPlacement, {});
  let panels = [...boxNodes];
  frontsPlacement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, frontsPlacement.normalAxis); });
  panels = [...panels, ...frontNodes];
  return { panels, front: frontNodes[0] };
}

// ---------------------------------------------------------------
// Default margins
// ---------------------------------------------------------------
section('computeDrawerBoxPlacement — default top/bottom margins inset the box from the front', () => {
  const { panels, front } = buildBoxWithDrawerFront();
  const resolved = resolveConstraints(panels);
  const frontResolved = resolved.find((r) => r.id === front.id);

  const placement = computeDrawerBoxPlacement(panels, front, BOX_SPEC);
  assert(placement.ok, 'placement succeeds with default margins');

  const expectedHeight = frontResolved.height - DEFAULT_DRAWER_BOX_TOP_MARGIN_MM - DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM;
  assertEqual(placement.left.dims.height, expectedHeight, 'left panel height = front height minus both default margins');
  assertEqual(placement.right.dims.height, expectedHeight, 'right panel height matches left');
  // Equal margins -> box is vertically centered on the front.
  assertEqual(placement.left.center.y, frontResolved.position.y, 'with equal top/bottom margins, the box is centered on the front');

  // Back sits on top of bottom, flush with the box's own (inset) top —
  // never the front's raw top edge.
  const boxTop = frontResolved.position.y + frontResolved.height / 2 - DEFAULT_DRAWER_BOX_TOP_MARGIN_MM;
  const backTop = placement.back.center.y + placement.back.dims.height / 2;
  assert(Math.abs(backTop - boxTop) < 1e-6, 'back\'s own top edge is flush with the box\'s inset top, not the front\'s raw top edge');
});

// ---------------------------------------------------------------
// Floor enforcement — can only increase, never reduce
// ---------------------------------------------------------------
section('computeDrawerBoxPlacement — a margin below the default floor is clamped back up to it', () => {
  const { panels, front } = buildBoxWithDrawerFront();
  const belowFloor = computeDrawerBoxPlacement(panels, front, { ...BOX_SPEC, topMarginMm: 5, bottomMarginMm: 2 });
  const atDefault = computeDrawerBoxPlacement(panels, front, BOX_SPEC);
  assert(belowFloor.ok && atDefault.ok, 'both placements succeed');
  assertEqual(belowFloor.left.dims.height, atDefault.left.dims.height, 'requesting margins below the default floor produces the SAME box as the default — the floor wins, not the requested value');
  assertEqual(belowFloor.left.center.y, atDefault.left.center.y, 'position is identical too, not just height');
});

section('computeDrawerBoxPlacement — a margin above the default floor is honored', () => {
  const { panels, front } = buildBoxWithDrawerFront();
  const resolved = resolveConstraints(panels);
  const frontResolved = resolved.find((r) => r.id === front.id);

  const widened = computeDrawerBoxPlacement(panels, front, { ...BOX_SPEC, topMarginMm: 40, bottomMarginMm: 40 });
  assert(widened.ok, 'placement succeeds with an enlarged margin');
  assertEqual(widened.left.dims.height, frontResolved.height - 80, 'a margin above the floor shrinks the box by the full requested amount, not clamped');
});

section('computeDrawerBoxPlacement — independently different top and bottom margins are each honored once above their own floor', () => {
  const { panels, front } = buildBoxWithDrawerFront();
  const resolved = resolveConstraints(panels);
  const frontResolved = resolved.find((r) => r.id === front.id);

  const asymmetric = computeDrawerBoxPlacement(panels, front, { ...BOX_SPEC, topMarginMm: 30, bottomMarginMm: 20 });
  assert(asymmetric.ok, 'placement succeeds');
  assertEqual(asymmetric.left.dims.height, frontResolved.height - 50, 'height reflects both independent margins (30 + 20)');
  // A bigger top margin than bottom margin shifts the box's center DOWN.
  assert(asymmetric.left.center.y < frontResolved.position.y, 'an asymmetric top-heavy margin pulls the box center below the front\'s own center');
});

// ---------------------------------------------------------------
// Real-clearance guard — against the carcass, not just the front
// ---------------------------------------------------------------
section('computeDrawerBoxPlacement — a front drifted out of alignment with its own carcass opening is refused, not silently built', () => {
  const { panels, front } = buildBoxWithDrawerFront();
  // Simulates the front having drifted (or the carcass having shrunk)
  // relative to each other after creation — the margin-from-front
  // arithmetic alone can't see this; only re-checking against the
  // carcass's own inner faces (boundaryResult.inner[axisB]) can. Shifts
  // the front 25mm further toward the carcass Top than its own
  // boundary allows, which at the 20mm margin floor leaves negative
  // real clearance to the Top panel's inner face.
  const driftedFront = { ...front, offset: { ...front.offset, y: front.offset.y + 25 } };
  const panelsWithDriftedFront = panels.map((p) => (p.id === front.id ? driftedFront : p));

  const placement = computeDrawerBoxPlacement(panelsWithDriftedFront, driftedFront, BOX_SPEC);
  assertEqual(placement.ok, false, 'placement is refused rather than built with negative real clearance');
  assertEqual(placement.reason, 'insufficient-clearance', 'refusal reason names the real-clearance guard specifically');
});

section('computeDrawerBoxPlacement — a front still within its carcass opening is never refused on clearance grounds', () => {
  const { panels, front } = buildBoxWithDrawerFront();
  const placement = computeDrawerBoxPlacement(panels, front, BOX_SPEC);
  assert(placement.ok, 'a normal, unperturbed drawer front always clears its own carcass by at least the margin floor');
  assert(DEFAULT_DRAWER_BOX_TOP_MARGIN_MM >= MIN_DRAWER_BOX_CLEARANCE_MM, 'sanity: the default margin floor is itself well above the minimum real-clearance requirement');
});

// ---------------------------------------------------------------
// Open transform — visual-only, 3/4 of the box's own depth
// ---------------------------------------------------------------

// Builds a plain box + one complete drawer (front AND its left/right/
// bottom/back box) — computeDrawerOpenTransform has nothing to read a
// depth off of without an actual built box (see its own null-return
// guard), unlike every other section above which only ever needed the
// front.
function buildBoxWithCompleteDrawer() {
  const { panels, front } = buildBoxWithDrawerFront();
  const boxPlacement = computeDrawerBoxPlacement(panels, front, BOX_SPEC);
  const boxNodes = createDrawerBoxNodes(panels, boxPlacement);
  return { panels: [...panels, ...boxNodes], front, boxNodes };
}

section('computeDrawerOpenTransform — shifts by 3/4 of the box\'s own built depth, along the front\'s normal axis', () => {
  const { panels, front, boxNodes } = buildBoxWithCompleteDrawer();
  const resolved = resolveConstraints(panels);
  const leftResolved = resolved.find((r) => r.id === boxNodes.find((n) => n.drawerBoxRole === 'left').id);
  const leftDepthMm = leftResolved[dimFieldForAxis(leftResolved.rotation, front.normalAxis)];

  const transform = computeDrawerOpenTransform(front, panels, resolved);
  assert(transform, 'a front with a built box produces an open transform');
  ['x', 'y', 'z'].filter((axis) => axis !== front.normalAxis).forEach((axis) => {
    assertEqual(transform.offsetMm[axis], 0, `no shift on the non-normal axis ${axis}`);
  });
  assert(Math.abs(transform.offsetMm[front.normalAxis]) > 0, 'a real shift is produced along the normal axis');
  assertEqual(Math.abs(transform.offsetMm[front.normalAxis]), leftDepthMm * DRAWER_OPEN_FRACTION, 'shift magnitude is exactly DRAWER_OPEN_FRACTION of the box\'s own left-panel depth, not a fixed constant');
});

section('computeDrawerOpenTransform — a deeper box opens further than a shallow one', () => {
  const shallow = buildBoxWithCompleteDrawer();
  const deep = buildBoxWithCompleteDrawer();
  const deepPlacement = computeDrawerBoxPlacement(deep.panels, deep.front, { ...BOX_SPEC, depthMarginMm: 5 }); // smaller margin -> deeper box than the default
  const deepBoxNodes = createDrawerBoxNodes(deep.panels, deepPlacement);
  // Rebuild deep's panel list with the deeper box replacing its original one.
  const deepFrontOnly = deep.panels.filter((p) => !p.isDrawerBoxPanel);
  const deepPanels = [...deepFrontOnly, ...deepBoxNodes];

  const shallowResolved = resolveConstraints(shallow.panels);
  const deepResolved = resolveConstraints(deepPanels);
  const shallowTransform = computeDrawerOpenTransform(shallow.front, shallow.panels, shallowResolved);
  const deepTransform = computeDrawerOpenTransform(deep.front, deepPanels, deepResolved);

  assert(
    Math.abs(deepTransform.offsetMm[deep.front.normalAxis]) > Math.abs(shallowTransform.offsetMm[shallow.front.normalAxis]),
    'a box built with a smaller depth margin (deeper box) opens further than the default-depth box'
  );
});

section('computeDrawerOpenTransform — a front with no box yet returns null, not a wrong number', () => {
  const { panels, front } = buildBoxWithDrawerFront(); // front only, no box built
  const resolved = resolveConstraints(panels);
  const transform = computeDrawerOpenTransform(front, panels, resolved);
  assertEqual(transform, null, 'no box to read a depth off -> null, rather than guessing or defaulting');
});

section('drawers are an INDEPENDENT group, linked to the cabinet for their sizes', () => {
  const { panels, front } = buildBoxWithDrawerFront();
  const cabinetGroup = panels.find((p) => p.isBoxWall).groupId;
  assert(front.groupId && front.groupId !== cabinetGroup, 'the drawer front is NOT in the cabinet group');
  assertEqual(front.boxGroupId, cabinetGroup, 'but it is linked to the cabinet it was sized from');
  assertEqual(boxGroupOf(front), cabinetGroup, 'boxGroupOf returns the cabinet group');

  const placement = computeDrawerBoxPlacement(panels, front, BOX_SPEC);
  const boxNodes = createDrawerBoxNodes(panels, placement);
  assert(boxNodes.every((n) => n.groupId === front.groupId), "the drawer box panels join the drawer's own group");
  assert(boxNodes.every((n) => n.boxGroupId === cabinetGroup), 'and link to the cabinet too');

  // Widen the cabinet: the drawer (a separate group) must still follow its size.
  let all = [...panels, ...boxNodes];
  const right = all.find((p) => p.isBoxWall && p.name === 'Right');
  all = all.map((p) => (p.id === right.id ? { ...p, offset: { ...p.offset, x: p.offset.x + 100 } } : p));
  const relaid = relayoutBox(all, cabinetGroup);
  assert(relaid.ok, 'cabinet relayout succeeds');
  all = all.map((p) => { const q = relaid.patches.find((x) => x.id === p.id); return q ? { ...p, ...q } : p; });
  const before = resolveConstraints(all).find((r) => r.id === front.id);
  all = applyDrawerAdjustmentsForGroup(all, cabinetGroup);
  const after = resolveConstraints(all).find((r) => r.id === front.id);
  const rightResolved = resolveConstraints(all).find((r) => r.id === right.id);
  assert(after.width !== before.width || after.position.x !== before.position.x, 'the drawer front re-fits to the resized cabinet');
  assert(rightResolved.position.x - after.position.x > 0, 'and stays inside it');
  assert(all.filter((p) => p.drawerBoxFrontId === front.id).length === 4, 'the drawer box is kept');
});

section('applyDrawerLayout — equal heights vs a height chosen per front', () => {
  const { nodes: boxNodes } = addBox([]);
  const boundaryResult = computeBoundaryRectangle(boxNodes, boundaryPanels(boxNodes));
  const placement = computeDrawerFrontsPlacement(boxNodes, boundaryResult, DEFAULT_DRAWER_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, count: 3 });
  let panels = [...boxNodes];
  placement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, placement.normalAxis); });
  panels = [...panels, ...createDrawerFrontNodes(boxNodes, placement, {})];
  const stackId = panels.find((p) => p.isDrawerFront).drawerStackId;
  const heights = (list) => list.filter((p) => p.isDrawerFront).sort((a, b) => a.drawerIndex - b.drawerIndex).map((p) => resolveConstraints(list).find((r) => r.id === p.id).height);
  const total = heights(panels).reduce((a, b) => a + b, 0);
  assert(heights(panels).every((h) => Math.abs(h - total / 3) < 0.01), 'starts as 3 equal drawers');

  const r = applyDrawerLayout(panels, stackId, { mode: 'custom', index: 2, valueMm: 100 });
  assert(r.ok, 'setting the top front to 100 mm works');
  const h = heights(r.panels);
  assert(Math.abs(h[2] - 100) < 0.01, 'the top front is exactly 100 mm');
  assert(Math.abs(h.reduce((a, b) => a + b, 0) - total) < 0.01, 'the stack still fills the opening exactly');
  assert(Math.abs(h[0] - h[1]) < 0.01 && Math.abs(h[0] - (total - 100) / 2) < 0.01, 'the fronts not fixed yet share the remaining height equally');

  const r2 = applyDrawerLayout(r.panels, stackId, { mode: 'custom', index: 1, valueMm: 150 });
  const h2 = heights(r2.panels);
  assert(r2.ok && Math.abs(h2[2] - 100) < 0.01 && Math.abs(h2[1] - 150) < 0.01, 'a second edit keeps the first fixed height');
  assert(Math.abs(h2[0] - (total - 250)) < 0.01, 'the last front left alone (here the bottom one) is the automatic one');
  assert(!applyDrawerLayout(r2.panels, stackId, { mode: 'custom', index: 0, valueMm: 100 }).ok, 'the automatic (last unfixed) front cannot be edited');

  const rr = applyDrawerLayout(r2.panels, stackId, { mode: 'custom', index: 1, reset: true });
  const hr = heights(rr.panels);
  assert(rr.ok && Math.abs(hr[2] - 100) < 0.01, 'resetting a front keeps the other fixed heights');
  assert(Math.abs(hr[0] - hr[1]) < 0.01 && Math.abs(hr[0] - (total - 100) / 2) < 0.01, 'the released front shares the remaining height equally with the free ones');

  // any front can be the automatic one: fix bottom + middle, the TOP is left over
  const t1 = applyDrawerLayout(panels, stackId, { mode: 'custom', index: 0, valueMm: 90 });
  const t2 = applyDrawerLayout(t1.panels, stackId, { mode: 'custom', index: 1, valueMm: 120 });
  const ht = heights(t2.panels);
  assert(t2.ok && Math.abs(ht[2] - (total - 210)) < 0.01, 'the top front can be the automatic one');
  assert(!applyDrawerLayout(t2.panels, stackId, { mode: 'custom', index: 2, valueMm: 100 }).ok, 'and then it is locked');

  const e = applyDrawerLayout(r.panels, stackId, { mode: 'equal' });
  assert(e.ok && heights(e.panels).every((x) => Math.abs(x - total / 3) < 0.01), 'back to equal heights');
  assert(!applyDrawerLayout(panels, stackId, { mode: 'custom', index: 2, valueMm: 5 }).ok, 'a front below the minimum is refused');
  assert(!applyDrawerLayout(panels, stackId, { mode: 'custom', index: 2, valueMm: total }).ok, 'a height that squeezes the others below the minimum is refused');
});

section('adding a plinth raises the drawers together with the box', () => {
  const { nodes: boxNodes } = addBox([]);
  const boundaryResult = computeBoundaryRectangle(boxNodes, boundaryPanels(boxNodes));
  const placement = computeDrawerFrontsPlacement(boxNodes, boundaryResult, DEFAULT_DRAWER_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, count: 2 });
  let panels = [...boxNodes];
  placement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, placement.normalAxis); });
  panels = [...panels, ...createDrawerFrontNodes(boxNodes, placement, {})];
  const posY = (list, id) => resolveConstraints(list).find((r) => r.id === id).position.y;
  const front = panels.find((p) => p.isDrawerFront);
  const wall = panels.find((p) => p.isBoxWall);
  const frontBefore = posY(panels, front.id);
  const wallBefore = posY(panels, wall.id);
  const res = addPlinthAndRaiseBox(panels, wall.groupId, {});
  assert(res.ok, 'a plinth can be added');
  const dyWall = posY(res.panels, wall.id) - wallBefore;
  assert(dyWall > 0, 'the box rises');
  assert(Math.abs((posY(res.panels, front.id) - frontBefore) - dyWall) < 0.01, 'the drawer front rises by the same amount');
});

report();

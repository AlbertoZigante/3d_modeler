/**
 * tests/assembly.test.mjs
 *
 * Empirical test harness for engine/assembly.js — same convention as
 * the rest of this project: real fixtures, exact assertions on order/
 * clustering/step content, not "doesn't crash" checks.
 *
 * Run with: node tests/assembly.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { addBox } from '../src/features/box.js';
import { computeBoundaryRectangle } from '../src/shared/geometry.js';
import { computeDoorPlacement, createDoorNode, applyPanelPatch, DEFAULT_DOOR_EDGE_FIT } from '../src/features/door.js';
import { computeDrawerFrontsPlacement, createDrawerFrontNodes, computeDrawerBoxPlacement, createDrawerBoxNodes, DEFAULT_DRAWER_EDGE_FIT } from '../src/features/drawer.js';
import { buildAssemblySequence, formatAssemblySequenceLines } from '../src/engine/assembly.js';

await ensureMaterialCatalog();

// ---------------------------------------------------------------
// Plain box — one cluster, pure structural build order
// ---------------------------------------------------------------
section('buildAssemblySequence — plain box', () => {
  const { nodes } = addBox([]);
  const sequence = buildAssemblySequence(nodes);

  assertEqual(sequence.clusters.length, 1, 'plain box: exactly one rigid cluster');
  assertEqual(sequence.clusters[0].panelIds.length, 5, 'plain box: cluster covers all 5 visible walls (Front hidden)');
  assertEqual(sequence.steps.length, 5, 'plain box: 5 join steps, one per panel, no pre_install/integrate/unattached steps');
  assert(sequence.steps.every((s) => s.kind === 'join'), 'plain box: every step is a join (no hardware, no features)');

  // First step is the anchor (no joints); every step after it references at least one joint
  assertEqual(sequence.steps[0].jointIds.length, 0, 'plain box: first step is the anchor, no joints yet');
  assert(sequence.steps.slice(1).every((s) => s.jointIds.length > 0), 'plain box: every step after the anchor realizes at least one joint');

  // Every joint across the whole design is realized EXACTLY once (no duplicate, no dropped joint)
  const allJointIds = new Set();
  sequence.steps.forEach((s) => s.jointIds.forEach((id) => {
    assert(!allJointIds.has(id), `plain box: joint ${id} is not realized twice across steps`);
    allJointIds.add(id);
  }));
  assertEqual(allJointIds.size, 8, 'plain box: all 8 corner_butt joints from the carcass are realized exactly once, total');

  // Each step only attaches ONE new panel — no step should introduce two never-before-seen panels
  const seenPanels = new Set();
  sequence.steps.forEach((s) => {
    const newOnes = s.panelIds.filter((id) => !seenPanels.has(id));
    assert(newOnes.length <= 1, `step ${s.index}: introduces at most one new panel (IKEA-style single-panel-per-step), got ${newOnes.length}`);
    s.panelIds.forEach((id) => seenPanels.add(id));
  });

  // Sanity: text formatting produces one line per step, correctly numbered
  const lines = formatAssemblySequenceLines(sequence);
  assertEqual(lines.length, 5, 'text output: one line per step');
  assert(lines[0].startsWith('01.'), 'text output: steps are 1-indexed and zero-padded');
});

// ---------------------------------------------------------------
// Door fixture — door must NOT be structurally joined to the carcass
// ---------------------------------------------------------------
section('buildAssemblySequence — door fixture', () => {
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

  const sequence = buildAssemblySequence(panels);
  assertEqual(sequence.clusters.length, 2, 'door fixture: 2 clusters — the carcass, and the door as its own singleton (NOT merged in via flush contact)');
  const doorCluster = sequence.clusters.find((c) => c.panelIds.includes(doorNode.id));
  assertEqual(doorCluster.panelIds.length, 1, 'door fixture: the door\'s cluster contains only itself');

  // No 'join' step should ever list the door as attaching via a structural joint
  const doorJoinSteps = sequence.steps.filter((s) => s.kind === 'join' && s.panelIds.includes(doorNode.id) && s.jointIds.length > 0);
  assertEqual(doorJoinSteps.length, 0, 'door fixture: the door never appears in a structural join step (no confirmat screws to the carcass)');

  // The door gets pre-install steps (hinge) on itself AND on the boundary panel (Left)
  const doorPreInstall = sequence.steps.filter((s) => s.kind === 'pre_install' && s.panelIds.includes(doorNode.id));
  const leftPreInstall = sequence.steps.filter((s) => s.kind === 'pre_install' && s.panelIds.includes(left.id));
  assertEqual(doorPreInstall.length, 1, 'door fixture: exactly one pre_install step for the door itself');
  assertEqual(leftPreInstall.length, 1, 'door fixture: exactly one pre_install step for the hinge-side boundary panel');

  // Exactly one integrate step, and it MUST be the very last step
  const integrateSteps = sequence.steps.filter((s) => s.kind === 'integrate');
  assertEqual(integrateSteps.length, 1, 'door fixture: exactly one integrate step (hanging the door)');
  assertEqual(integrateSteps[0].index, sequence.steps.length, 'door fixture: the hang-door step is the LAST step in the whole sequence');
  assert(integrateSteps[0].panelIds.includes(doorNode.id) && integrateSteps[0].panelIds.includes(left.id), 'door fixture: the integrate step references both the door and the Left boundary panel');

  // The door's pre_install step comes before the integrate step, obviously, but also
  // before ALL of the carcass's own join steps is NOT required — only relative to
  // its OWN integrate step. Confirm ordering sanity: pre_install < integrate.
  assert(doorPreInstall[0].index < integrateSteps[0].index, 'door fixture: hinge pre_install happens before hanging the door');
});

// ---------------------------------------------------------------
// Drawer fixture — drawer box is its own cluster, NOT fused to the
// carcass via incidental Top/Bottom/Back contact
// ---------------------------------------------------------------
let drawerSequence;
let drawerFixturePanels;
section('buildAssemblySequence — drawer fixture', () => {
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
  drawerFixturePanels = panels;

  const sequence = buildAssemblySequence(panels);
  drawerSequence = sequence;

  assertEqual(sequence.clusters.length, 3, 'drawer fixture: 3 clusters — carcass, drawer box, and the drawer front singleton');

  const boxLeftRaw = drawerBoxNodes.find((n) => n.drawerBoxRole === 'left');
  const boxRightRaw = drawerBoxNodes.find((n) => n.drawerBoxRole === 'right');
  const boxBottomRaw = drawerBoxNodes.find((n) => n.drawerBoxRole === 'bottom');
  const boxBackRaw = drawerBoxNodes.find((n) => n.drawerBoxRole === 'back');
  const drawerBoxCluster = sequence.clusters.find((c) => c.panelIds.includes(boxLeftRaw.id));
  assertEqual(drawerBoxCluster.panelIds.length, 4, 'drawer fixture: the drawer box cluster contains exactly its own 4 panels');
  assert(
    [boxLeftRaw, boxRightRaw, boxBottomRaw, boxBackRaw].every((n) => drawerBoxCluster.panelIds.includes(n.id)),
    'drawer fixture: drawer box cluster contains left/right/bottom/back specifically'
  );
  assert(!drawerBoxCluster.panelIds.includes(left.id), 'drawer fixture: drawer box cluster does NOT include the carcass Left panel, despite any incidental contact');

  // No structural join step ever mixes a drawer box panel with a carcass panel
  const carcassIds = new Set([left.id, right.id, top.id, bottom.id, boxNodes.find((n) => n.name === 'Back').id]);
  const drawerBoxIds = new Set(drawerBoxNodes.map((n) => n.id));
  sequence.steps.filter((s) => s.kind === 'join' && s.jointIds.length > 0).forEach((s) => {
    const touchesCarcass = s.panelIds.some((id) => carcassIds.has(id));
    const touchesDrawerBox = s.panelIds.some((id) => drawerBoxIds.has(id));
    assert(!(touchesCarcass && touchesDrawerBox), `step ${s.index}: never mixes a carcass panel and a drawer-box panel in one structural join`);
  });

  // Runner pre-installs: one on each carcass side, one on each drawer box side
  const runnerPreInstalls = sequence.steps.filter((s) => s.kind === 'pre_install' && s.hardware.some((h) => h.kind === 'runner'));
  assertEqual(runnerPreInstalls.length, 4, 'drawer fixture: 4 runner pre_install steps (2 sides x 2 panels each)');

  // Drawer front: known gap, honestly flagged
  const frontNode = frontNodes[0];
  const frontStep = sequence.steps.find((s) => s.panelIds.includes(frontNode.id));
  assert(!!frontStep, 'drawer fixture: the drawer front appears somewhere in the sequence');
  assertEqual(frontStep.kind, 'unattached', 'drawer fixture: the drawer front is honestly flagged as unattached (known gap — see file header)');

  // Integration: exactly one, referencing both drawer box sides and both carcass sides, combined into ONE step
  const integrateSteps = sequence.steps.filter((s) => s.kind === 'integrate');
  assertEqual(integrateSteps.length, 1, 'drawer fixture: the two drawer_slide FeatureJoints (left+right) collapse into ONE integrate step');
  assert(integrateSteps[0].panelIds.includes(boxLeftRaw.id) && integrateSteps[0].panelIds.includes(boxRightRaw.id), 'drawer fixture: integrate step references both drawer box sides');
  assert(integrateSteps[0].panelIds.includes(left.id) && integrateSteps[0].panelIds.includes(right.id), 'drawer fixture: integrate step references both carcass sides');
  assertEqual(integrateSteps[0].hardware.length, 2, 'drawer fixture: integrate step carries both runner hardware entries');

  // The integrate step must come after EVERY step belonging to either the carcass or drawer-box clusters
  const structuralStepIndices = sequence.steps
    .filter((s) => s.kind !== 'integrate' && s.kind !== 'unattached')
    .map((s) => s.index);
  assert(integrateSteps[0].index > Math.max(...structuralStepIndices), 'drawer fixture: drawer insertion happens after both the carcass and the drawer box are fully built');
});

// ---------------------------------------------------------------
// Determinism — same input always produces the same sequence
// ---------------------------------------------------------------
section('buildAssemblySequence — determinism', () => {
  const seqA = buildAssemblySequence(drawerFixturePanels);
  const seqB = buildAssemblySequence(drawerFixturePanels);
  const linesA = formatAssemblySequenceLines(seqA);
  const linesB = formatAssemblySequenceLines(seqB);
  assertEqual(linesA.join('\n'), linesB.join('\n'), 'determinism: calling buildAssemblySequence twice on the same panels produces an identical sequence');
});

report();

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
import { STAGES } from '../src/engine/assembly/stages/index.js';
import { makeIsSameRigidUnit } from '../src/engine/assembly/clusters.js';
import { addPlinthAndRaiseBox } from '../src/features/plinth.js';
import { panelRole } from '../src/engine/assembly/roles.js';

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
  assert(lines[0].startsWith('S01.'), 'text output: steps are 1-indexed and zero-padded');
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

// ---------------------------------------------------------------
// Stage order — doors+handles, drawers, drawer guides, plinth, then
// the rest of the furniture, then integration
// ---------------------------------------------------------------
const STAGE_IDS = STAGES.map((s) => s.id);

function buildStagedFixture() {
  // drawer fixture + a door + two plinth boards, all on the same carcass
  let panels = [...drawerFixturePanels];
  const byName = (n) => panels.find((p) => p.name === n);
  const boundary = computeBoundaryRectangle(panels, [byName('Left'), byName('Right'), byName('Top'), byName('Bottom')]);
  const doorPlacement = computeDoorPlacement(panels, boundary, DEFAULT_DOOR_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, hinge: 'left' });
  const doorNode = createDoorNode(panels, doorPlacement);
  doorPlacement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, doorPlacement.normalAxis); });
  const template = panels.find((p) => p.name === 'Left');
  const plinthFront = { ...template, id: 'plinth-front', name: 'Plinth Front', pieceCode: 'PL0001', isPlinth: true, isBoxWall: false, isBoxPanel: false, groupId: null, hidden: false, constraints: [] };
  const plinthBack = { ...template, id: 'plinth-back', name: 'Plinth Back', pieceCode: 'PL0002', isPlinth: true, isBoxWall: false, isBoxPanel: false, groupId: null, hidden: false, constraints: [] };
  panels = [...panels, doorNode, plinthFront, plinthBack];
  return { panels, doorNode, plinthIds: [plinthFront.id, plinthBack.id] };
}

section('buildAssemblySequence — stage order (doors, drawers, guides, plinth, carcass)', () => {
  const { panels, doorNode, plinthIds } = buildStagedFixture();
  const seq = buildAssemblySequence(panels);

  assertEqual(seq.stages.map((s) => s.id).join(','), 'doors,drawers,guides,plinth,carcass,integration', 'stages: exposed in the required order');
  assert(seq.steps.every((s) => STAGE_IDS.includes(s.stage)), 'every step carries a known stage id');

  // Stage index never goes backwards through the sequence
  let last = -1;
  seq.steps.forEach((s) => {
    const idx = STAGE_IDS.indexOf(s.stage);
    assert(idx >= last, `step ${s.stepId} (${s.stage}) does not come before an earlier stage`);
    last = Math.max(last, idx);
  });

  const stageSteps = (id) => seq.steps.filter((s) => s.stage === id);
  ['doors', 'drawers', 'guides', 'plinth', 'carcass', 'integration'].forEach((id) => assert(stageSteps(id).length > 0, `stage ${id} has steps`));

  // 1. doors: door panel, then its handle, and the handle is the last door step
  const doorSteps = stageSteps('doors');
  assert(doorSteps.every((s) => s.panelIds.includes(doorNode.id)), 'doors stage only touches the door');
  const handleStep = doorSteps.find((s) => s.kind === 'fit_handle');
  assert(!!handleStep, 'doors stage: the door gets a handle step');
  assertEqual(handleStep.index, doorSteps[doorSteps.length - 1].index, 'doors stage: handle is the last door step');
  assertEqual(handleStep.hardware[0].kind, 'handle', 'doors stage: handle step carries a handle hardware entry');
  assert(handleStep.subassemblyComplete, 'doors stage: the door (with handle) is flagged complete');

  // 2. drawers: box panels first, then front, then front handle
  const drawerSteps = stageSteps('drawers');
  assert(drawerSteps.some((s) => s.clusterKind === 'drawer_box'), 'drawers stage: drawer box panels present');
  assert(drawerSteps.some((s) => s.clusterKind === 'drawer_front'), 'drawers stage: drawer front present');
  const lastBoxIdx = Math.max(...drawerSteps.filter((s) => s.clusterKind === 'drawer_box').map((s) => s.index));
  const firstFrontIdx = Math.min(...drawerSteps.filter((s) => s.clusterKind === 'drawer_front').map((s) => s.index));
  assert(lastBoxIdx < firstFrontIdx, 'drawers stage: drawer box is finished before the front');
  assertEqual(drawerSteps.filter((s) => s.kind === 'fit_handle').length, 1, 'drawers stage: exactly one handle (drawer front)');

  // 3. guides: runner brackets on the carcass panels, before any carcass join
  const guideSteps = stageSteps('guides');
  assertEqual(guideSteps.length, 2, 'guides stage: one guide per carcass side');
  assert(guideSteps.every((s) => s.kind === 'pre_install' && s.hardware[0].kind === 'runner'), 'guides stage: runner pre-installs only');
  const carcassFirst = Math.min(...stageSteps('carcass').map((s) => s.index));
  assert(guideSteps.every((s) => s.index < carcassFirst), 'guides stage: all guides are fitted before the carcass starts');
  const carcassRunnerPreinstalls = stageSteps('carcass').filter((s) => s.kind === 'pre_install' && s.hardware.some((h) => h.kind === 'runner'));
  assertEqual(carcassRunnerPreinstalls.length, 0, 'carcass stage: runner brackets are not installed a second time');

  // 4. plinth: own sub-assemblies, before the carcass, fitted at integration
  const plinthSteps = stageSteps('plinth');
  assert(plinthSteps.every((s) => s.panelIds.every((id) => plinthIds.includes(id))), 'plinth stage: only plinth panels');
  assert(plinthSteps.every((s) => s.kind !== 'unattached'), 'plinth stage: plinth is not flagged as unattached');
  assert(plinthSteps.every((s) => s.index < carcassFirst), 'plinth stage: before the carcass');
  assert(Math.min(...guideSteps.map((s) => s.index)) > Math.max(...drawerSteps.map((s) => s.index)), 'guides come after all drawer steps');
  assert(Math.min(...plinthSteps.map((s) => s.index)) > Math.max(...guideSteps.map((s) => s.index)), 'plinth comes after all guide steps');
  plinthIds.forEach((id) => {
    const cluster = seq.clusters.find((c) => c.panelIds.includes(id));
    assertEqual(cluster.role, 'plinth', `plinth panel ${id} sits in a plinth cluster, not the carcass`);
  });

  // 6. integration: plinth fit first, hinges last
  const integ = stageSteps('integration');
  assert(integ[0].panelIds.some((id) => plinthIds.includes(id)), 'integration: plinth is fitted first');
  assertEqual(integ[integ.length - 1].panelIds[0], doorNode.id, 'integration: hanging the door is still the last step');
  const lines = formatAssemblySequenceLines(seq);
  assertEqual(lines.length, seq.steps.length, 'text output still has one line per step');
});

section('assembly roles — plinth detection and rigid units', () => {
  assertEqual(panelRole({ name: 'Plinth Front' }), 'plinth', 'name "Plinth Front" -> plinth');
  assertEqual(panelRole({ name: 'Kickboard' }), 'plinth', 'name "Kickboard" -> plinth');
  assertEqual(panelRole({ name: 'Zoccolo' }), 'plinth', 'name "Zoccolo" -> plinth');
  assertEqual(panelRole({ name: 'Anything', isPlinth: true }), 'plinth', 'isPlinth flag -> plinth');
  assertEqual(panelRole({ name: 'Bottom' }), 'bottom', 'Bottom is still a bottom, not a plinth');
  const raw = new Map([
    ['p1', { id: 'p1', name: 'Plinth Front' }],
    ['p2', { id: 'p2', name: 'Plinth Side' }],
    ['c1', { id: 'c1', name: 'Bottom' }],
  ]);
  const same = makeIsSameRigidUnit(raw);
  assert(same('p1', 'p2'), 'plinth boards join each other');
  assert(!same('p1', 'c1'), 'plinth never rigidly joins the carcass (incidental contact)');
});

section('buildAssemblySequence — real plinth feature (addPlinthAndRaiseBox)', () => {
  const { nodes } = addBox([]);
  const added = addPlinthAndRaiseBox(nodes, nodes[0].groupId, {});
  assert(added.ok, 'plinth added to the box');
  const seq = buildAssemblySequence(added.panels);
  const plinthPanelIds = added.panels.filter((p) => p.isPlinthPanel).map((p) => p.id);
  const plinthCluster = seq.clusters.find((c) => c.role === 'plinth');
  assert(!!plinthCluster, 'plinth panels form their own sub-assembly');
  assertEqual(plinthCluster.panelIds.length, plinthPanelIds.length, 'every plinth panel (perimeter + ribs) is in it');
  const firstCarcass = seq.steps.find((s) => s.stage === 'carcass');
  assert(seq.steps.filter((s) => s.stage === 'plinth').every((s) => s.index < firstCarcass.index), 'plinth is built before the carcass');
  const last = seq.steps[seq.steps.length - 1];
  assertEqual(last.kind, 'integrate', 'plinth is fitted in the integration stage');
  assert(plinthPanelIds.every((id) => last.panelIds.includes(id)), 'the integration step names the plinth panels');
});

report();

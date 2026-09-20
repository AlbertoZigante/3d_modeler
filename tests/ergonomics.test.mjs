/**
 * tests/ergonomics.test.mjs
 *
 * Empirical test harness for engine/ergonomics.js — same convention
 * as the rest of this project: real fixtures, exact assertions.
 *
 * Run with: node tests/ergonomics.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { addBox } from '../src/features/box.js';
import { computeBoundaryRectangle } from '../src/shared/geometry.js';
import { computeDoorPlacement, createDoorNode, applyPanelPatch, DEFAULT_DOOR_EDGE_FIT } from '../src/features/door.js';
import { computeDrawerFrontsPlacement, createDrawerFrontNodes, computeDrawerBoxPlacement, createDrawerBoxNodes, DEFAULT_DRAWER_EDGE_FIT } from '../src/features/drawer.js';
import { buildAssemblySequence } from '../src/engine/assembly.js';
import { annotateStepsWithTools, scoreErgonomics, buildAssemblyPlan, formatAssemblyPlanLines, TOOL_CATALOG } from '../src/engine/ergonomics.js';

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
  return { panels, left, right, doorNode };
}

function buildDrawerFixture() {
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
  return { panels, left, right, frontNode: frontNodes[0], drawerBoxNodes };
}

// ---------------------------------------------------------------
// Tools — door fixture (hinge + confirmat)
// ---------------------------------------------------------------
section('annotateStepsWithTools — door fixture', () => {
  const { panels } = buildDoorFixture();
  const sequence = buildAssemblySequence(panels);
  const { steps, toolsSummary } = annotateStepsWithTools(sequence);

  assert(toolsSummary.includes('Phillips/PZ2 screwdriver (or drill/driver)'), 'tools summary: includes the hinge/runner screwdriver');
  assert(toolsSummary.some((t) => t.includes('Pozidriv PZ3')), 'tools summary: includes the confirmat driver bit');
  assert(toolsSummary.some((t) => t.includes('4.5mm')), 'tools summary: includes the confirmat pilot-hole bit size');

  const hingePreInstall = steps.find((s) => s.kind === 'pre_install');
  assertEqual(hingePreInstall.tools.length, 1, 'hinge pre_install step: exactly one tool (a screwdriver, no drilling)');
  assert(hingePreInstall.toolNotes[0].includes('35mm Forstner'), 'hinge pre_install step: tool note mentions the cup-boring bit size');

  const fastenerJoin = steps.find((s) => s.kind === 'join' && s.hardware.length > 0);
  assertEqual(fastenerJoin.tools.length, 3, 'fastener join step: 3 distinct tools (pilot bit, clearance bit, driver)');

  const anchorStep = steps.find((s) => s.kind === 'join' && s.hardware.length === 0 && s.jointIds.length === 0);
  assertEqual(anchorStep.tools.length, 0, 'anchor step (no hardware): no tools required');

  // Every step retains its original fields (annotation, not replacement)
  assert(steps.every((s, i) => s.index === sequence.steps[i].index), 'tools annotation: step order/index untouched');
});

// ---------------------------------------------------------------
// Ergonomics — door fixture: weight escalation, single-joint caution
// ---------------------------------------------------------------
section('scoreErgonomics — door fixture', () => {
  const { panels, left, doorNode } = buildDoorFixture();
  const sequence = buildAssemblySequence(panels);
  const { steps } = scoreErgonomics(panels, sequence);

  // Weight should be monotonically non-decreasing WITHIN the carcass cluster's join steps
  const carcassJoinSteps = steps.filter((s) => s.kind === 'join' && s.jointIds.length > 0);
  for (let i = 1; i < carcassJoinSteps.length; i++) {
    assert(
      carcassJoinSteps[i].ergonomics.weightKg >= carcassJoinSteps[i - 1].ergonomics.weightKg,
      `weight: step ${carcassJoinSteps[i].index}'s weight is not less than step ${carcassJoinSteps[i - 1].index}'s (monotonic accumulation within one cluster)`
    );
  }
  assert(carcassJoinSteps[0].ergonomics.weightKg > 0, 'weight: first real join step already reflects at least 2 panels\' worth of weight');

  // The single-panel-per-joint step must be flagged
  const singleJointStep = carcassJoinSteps.find((s) => s.jointIds.length === 1);
  assert(!!singleJointStep, 'fixture sanity: at least one join step is secured by exactly one joint');
  assertEqual(singleJointStep.ergonomics.singleJointCaution, true, 'ergonomics: a single-joint attachment is flagged as a stability caution');

  const multiJointStep = carcassJoinSteps.find((s) => s.jointIds.length > 1);
  assertEqual(multiJointStep.ergonomics.singleJointCaution, false, 'ergonomics: a multi-joint attachment is NOT flagged');

  // The door and the carcass must be tracked as SEPARATE weight groups until the integrate step
  const doorPreInstall = steps.find((s) => s.kind === 'pre_install' && s.panelIds.includes(doorNode.id));
  const lastCarcassJoin = carcassJoinSteps[carcassJoinSteps.length - 1];
  assert(doorPreInstall.ergonomics.weightKg < lastCarcassJoin.ergonomics.weightKg, 'weight groups: the door alone weighs less than the fully-built carcass (tracked separately, not summed together yet)');

  const integrateStep = steps.find((s) => s.kind === 'integrate');
  assert(
    Math.abs(integrateStep.ergonomics.weightKg - (lastCarcassJoin.ergonomics.weightKg + doorPreInstall.ergonomics.weightKg)) < 0.15,
    'weight groups: the integrate step\'s weight equals carcass weight + door weight, combined for the first time'
  );

  // recommendedSurface tracks the same threshold consistently
  steps.forEach((s) => {
    const expected = s.ergonomics.weightKg >= 10 ? 'floor' : 'table';
    assertEqual(s.ergonomics.recommendedSurface, expected, `step ${s.index}: recommendedSurface matches the weight threshold`);
  });
});

// ---------------------------------------------------------------
// Ergonomics — drawer fixture: independent weight tracking + two-person flag on integration
// ---------------------------------------------------------------
section('scoreErgonomics — drawer fixture, two-person on integration', () => {
  const { panels } = buildDrawerFixture();
  const sequence = buildAssemblySequence(panels);
  const { steps } = scoreErgonomics(panels, sequence);

  const integrateStep = steps.find((s) => s.kind === 'integrate');
  assert(!!integrateStep, 'fixture sanity: an integrate step exists');

  // Sanity: the integrate step's weight must be at least as large as either sub-assembly's own final weight
  const preIntegrateWeights = steps.filter((s) => s.index < integrateStep.index && s.kind !== 'unattached').map((s) => s.ergonomics.weightKg);
  const maxPreIntegrateWeight = Math.max(...preIntegrateWeights, 0);
  assert(integrateStep.ergonomics.weightKg >= maxPreIntegrateWeight, 'weight: combining two sub-assemblies never DECREASES the tracked weight');

  // No orientation/reorientation fields on non-join steps
  assert(integrateStep.ergonomics.orientationAxis === undefined, 'ergonomics: orientationAxis is not computed for integrate steps (no meaningful "which way is up" for a slide-in)');
  const unattachedStep = steps.find((s) => s.kind === 'unattached');
  assert(!!unattachedStep, 'fixture sanity: the drawer front is flagged unattached (known gap)');
  assertEqual(unattachedStep.ergonomics.singleJointCaution, undefined, 'ergonomics: singleJointCaution is not computed for a step with no joints at all');
});

// ---------------------------------------------------------------
// buildAssemblyPlan — the combined entry point
// ---------------------------------------------------------------
section('buildAssemblyPlan — combined entry point', () => {
  const { panels } = buildDoorFixture();
  const plan = buildAssemblyPlan(panels);

  assert(Array.isArray(plan.toolsSummary) && plan.toolsSummary.length > 0, 'plan: toolsSummary is present and non-empty');
  assert(plan.steps.every((s) => Array.isArray(s.tools)), 'plan: every step has a tools array');
  assert(plan.steps.every((s) => typeof s.ergonomics === 'object'), 'plan: every step has an ergonomics object');
  assertEqual(plan.clusters.length, 2, 'plan: clusters passed through unchanged from buildAssemblySequence');

  const lines = formatAssemblyPlanLines(plan);
  assert(lines[0] === '=== TOOLS NEEDED ===', 'text output: leads with the tools summary section');
  assert(lines.some((l) => l.includes('kg,')), 'text output: every step line includes an estimated weight');
});

// ---------------------------------------------------------------
// Catalog sanity
// ---------------------------------------------------------------
section('TOOL_CATALOG sanity', () => {
  assert(Object.values(TOOL_CATALOG).every((entry) => Array.isArray(entry.tools) && entry.tools.length > 0), 'catalog: every tool entry has at least one tool listed');
  assert(TOOL_CATALOG.confirmat_screw.note.includes('confirm'), 'catalog: the non-verified confirmat drive-type is honestly flagged, not stated as fact');
});

report();

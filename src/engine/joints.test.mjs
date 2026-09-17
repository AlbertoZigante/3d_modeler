/**
 * tests/joints.test.mjs
 *
 * Empirical test harness for engine/joints.js — asserts on EXACT
 * expected joint counts/types against the REAL addBox()/addShelf()/
 * resolveConstraints() output, not hand-waved "doesn't crash" checks
 * (same convention as the rest of this project's geometry tests).
 *
 * Run with: node tests/joints.test.mjs
 *
 * Phases, matching the agreed detectJoints() development plan:
 *   1. face_to_face + corner_butt on a plain 6-panel box
 *   2. t_butt once a shelf is added
 *   3. near_contact (synthetic small gap)
 *   4. interpenetration -> collisions, not joints (synthetic overlap)
 *   5. edge_to_edge — deliberately SKIPPED: nothing in the current
 *      feature set (box/shelf/door/drawer) constructs two panels that
 *      meet edge-to-edge with no broad face involved. Don't write a
 *      test against geometry the app can't yet produce — add this
 *      once face frames/trim exist and there's a real fixture.
 *   6. groups — NOT decided here; sameGroup is reported on every
 *      Joint as an informational flag, but whether cross-group
 *      contact should be suppressed/handled differently for the
 *      attachTool UI is a policy call for that layer, not this one.
 *
 * Plus: a pair-ordering symmetry regression (a real bug class in
 * pairwise geometry code — see the git history's own edge-fit/
 * relayoutBox bugs), and direct classifyJoint()/declareJoint() checks
 * against the exact contract tools/attachTool.js depends on.
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { createPanelNode } from '../src/modeller/modules.js';
import { addBox } from '../src/features/box.js';
import { addShelf } from '../src/features/shelf.js';
import { computeBoundaryRectangle } from '../src/shared/geometry.js';
import { computeDoorPlacement, createDoorNode, applyPanelPatch, DEFAULT_DOOR_EDGE_FIT } from '../src/features/door.js';
import { computeDrawerFrontsPlacement, createDrawerFrontNodes, computeDrawerBoxPlacement, createDrawerBoxNodes, DEFAULT_DRAWER_EDGE_FIT } from '../src/features/drawer.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import { detectJoints, classifyJoint, declareJoint, findOrphanPanels, findCrossGroupJoints, buildJointsReport, formatJointsReportLines, formatJointTableRow, computeJointExtremities, detectFeatureJoints, formatFeatureJointTableRow } from '../src/engine/joints.js';

await ensureMaterialCatalog();

function byName(resolved, name) {
  return resolved.find((r) => r.name === name);
}

function findJoint(joints, resolved, nameA, nameB) {
  const idA = byName(resolved, nameA).id;
  const idB = byName(resolved, nameB).id;
  return joints.find(
    (j) => (j.panelA === idA && j.panelB === idB) || (j.panelA === idB && j.panelB === idA)
  );
}

// ---------------------------------------------------------------
// Phase 1 — plain box: face_to_face + corner_butt
// ---------------------------------------------------------------
section('Phase 1 — plain box (corner_butt only)', () => {
  const { nodes } = addBox([]);
  const resolved = resolveConstraints(nodes);
  const { joints, collisions } = detectJoints(resolved);

  assertEqual(collisions.length, 0, 'plain box: no collisions');
  // Front is hidden by default (see box.js) — 5 visible walls, each
  // touching its carcass neighbor exactly once: Left/Right each touch
  // Top, Bottom, Back (6); Top/Bottom each touch Back (2). 8 total.
  assertEqual(joints.length, 8, 'plain box: exactly 8 joints among the 5 visible walls');
  assert(joints.every((j) => j.type === 'corner_butt'), 'plain box: every joint classifies as corner_butt');
  assert(joints.every((j) => j.status === 'classified'), 'plain box: every joint fully classified');
  assert(joints.every((j) => j.gap === 0), 'plain box: every joint is a true (zero-gap) touch');

  const pairs = [
    ['Left', 'Top'], ['Left', 'Bottom'], ['Left', 'Back'],
    ['Right', 'Top'], ['Right', 'Bottom'], ['Right', 'Back'],
    ['Top', 'Back'], ['Bottom', 'Back'],
  ];
  pairs.forEach(([a, b]) => {
    assert(!!findJoint(joints, resolved, a, b), `plain box: ${a} <-> ${b} joint detected`);
  });
  // Panels that do NOT touch each other at all
  assert(!findJoint(joints, resolved, 'Left', 'Right'), 'plain box: Left and Right do not touch');
  assert(!findJoint(joints, resolved, 'Top', 'Bottom'), 'plain box: Top and Bottom do not touch');

  // No joint should reference the hidden Front panel
  const front = byName(resolved, 'Front');
  assert(joints.every((j) => j.panelA !== front.id && j.panelB !== front.id), 'plain box: hidden Front produces no joints');
});

// ---------------------------------------------------------------
// Phase 2 — box + horizontal shelf: t_butt
// ---------------------------------------------------------------
let shelfFixture;
section('Phase 2 — box + horizontal shelf (t_butt)', () => {
  const { nodes: boxNodes } = addBox([]);
  const left = boxNodes.find((n) => n.name === 'Left');
  const right = boxNodes.find((n) => n.name === 'Right');
  const shelfResult = addShelf(boxNodes, left, right, { mode: 'horizontal', clickMm: null });
  assert(shelfResult.ok, 'shelf placement succeeds in an empty box');

  const allNodes = [...boxNodes, shelfResult.node];
  const resolved = resolveConstraints(allNodes);
  const { joints, collisions } = detectJoints(resolved);
  shelfFixture = { allNodes, resolved, joints };

  assertEqual(collisions.length, 0, 'box+shelf: no collisions');

  const leftShelf = findJoint(joints, resolved, 'Left', 'Shelf (H)');
  const rightShelf = findJoint(joints, resolved, 'Right', 'Shelf (H)');
  assert(!!leftShelf, 'box+shelf: Left <-> Shelf joint detected');
  assert(!!rightShelf, 'box+shelf: Right <-> Shelf joint detected');
  assertEqual(leftShelf?.type, 't_butt', 'box+shelf: Left <-> Shelf classifies as t_butt (mid-height, not a corner)');
  assertEqual(rightShelf?.type, 't_butt', 'box+shelf: Right <-> Shelf classifies as t_butt');
  assertEqual(leftShelf?.contactAxis, 'x', 'box+shelf: Left <-> Shelf contact runs along X (Left is the flat/broad panel)');

  // The original 8 carcass joints must still all be present and still corner_butt —
  // adding a shelf must never perturb the existing wall-to-wall classification.
  const carcassPairs = [
    ['Left', 'Top'], ['Left', 'Bottom'], ['Left', 'Back'],
    ['Right', 'Top'], ['Right', 'Bottom'], ['Right', 'Back'],
    ['Top', 'Back'], ['Bottom', 'Back'],
  ];
  carcassPairs.forEach(([a, b]) => {
    const j = findJoint(joints, resolved, a, b);
    assert(!!j && j.type === 'corner_butt', `box+shelf: ${a} <-> ${b} is still corner_butt`);
  });
});

// ---------------------------------------------------------------
// Phase 3 — near_contact (synthetic small gap)
// ---------------------------------------------------------------
section('Phase 3 — near_contact', () => {
  // Two plain flat panels (PARALLEL_ROTATION, thickness axis Z),
  // fully overlapping in X/Y, separated by a deliberate 1.5mm gap in Z
  // — inside nearContactToleranceMm (3mm) but well outside
  // contactEpsilonMm (0.05mm), so this must NOT read as a true touch.
  const a = createPanelNode({ name: 'A', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  const b = createPanelNode({ name: 'B', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  a.basePosition = { x: 0, y: 0, z: 0 };
  b.basePosition = { x: 0, y: 0, z: 18 + 1.5 }; // a's +z face at z=9; b's -z face at z=(18+1.5)-9=10.5 -> 1.5mm gap
  const resolved = resolveConstraints([a, b]);
  const { joints, collisions } = detectJoints(resolved);

  assertEqual(collisions.length, 0, 'near_contact: not a collision');
  assertEqual(joints.length, 1, 'near_contact: exactly one joint detected');
  assertEqual(joints[0]?.type, 'near_contact', 'near_contact: classified as near_contact, not a true touch');
  assert(Math.abs(joints[0]?.gap - 1.5) < 1e-6, 'near_contact: reported gap matches the deliberate 1.5mm separation');

  // Push it just outside the tolerance band (5mm > 3mm default) -> no joint at all
  b.basePosition = { x: 0, y: 0, z: 18 + 5 };
  const resolvedFar = resolveConstraints([a, b]);
  const far = detectJoints(resolvedFar);
  assertEqual(far.joints.length, 0, 'near_contact: beyond nearContactToleranceMm produces no joint');
});

// ---------------------------------------------------------------
// Phase 4 — interpenetration -> collisions, never joints
// ---------------------------------------------------------------
section('Phase 4 — interpenetration routed to collisions', () => {
  const a = createPanelNode({ name: 'A', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  const b = createPanelNode({ name: 'B', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  a.basePosition = { x: 0, y: 0, z: 0 };
  b.basePosition = { x: 0, y: 0, z: 5 }; // deliberately overlapping on X, Y, AND Z at once
  const resolved = resolveConstraints([a, b]);
  const { joints, collisions } = detectJoints(resolved);

  assertEqual(joints.length, 0, 'interpenetration: produces no joint');
  assertEqual(collisions.length, 1, 'interpenetration: produces exactly one collision');
  assert(collisions[0]?.overlapMm.x > 0 && collisions[0]?.overlapMm.y > 0 && collisions[0]?.overlapMm.z > 0,
    'interpenetration: overlap reported on all three axes');
});

// ---------------------------------------------------------------
// Pair-ordering symmetry regression
// ---------------------------------------------------------------
section('Symmetry — pair order must not change classification', () => {
  const { nodes } = addBox([]);
  const resolved = resolveConstraints(nodes);
  const forward = detectJoints(resolved).joints;
  const reversed = detectJoints([...resolved].reverse()).joints;

  assertEqual(forward.length, reversed.length, 'symmetry: same joint count regardless of array order');

  const left = byName(resolved, 'Left');
  const top = byName(resolved, 'Top');
  const jf = forward.find((j) => (j.panelA === left.id && j.panelB === top.id) || (j.panelA === top.id && j.panelB === left.id));
  const jr = reversed.find((j) => (j.panelA === left.id && j.panelB === top.id) || (j.panelA === top.id && j.panelB === left.id));
  assert(!!jf && !!jr, 'symmetry: Left<->Top found in both orderings');
  assertEqual(jf?.type, jr?.type, 'symmetry: same joint type regardless of which panel is "A"');
  assertEqual(jf?.contactAxis, jr?.contactAxis, 'symmetry: same contact axis regardless of order');
  // faceA/faceB (and panelA/panelB) should swap consistently with which panel ended up "A"
  const fLeftIsA = jf.panelA === left.id;
  const rLeftIsA = jr.panelA === left.id;
  const fLeftFace = fLeftIsA ? jf.faceA : jf.faceB;
  const rLeftFace = rLeftIsA ? jr.faceA : jr.faceB;
  assertEqual(fLeftFace, rLeftFace, "symmetry: Left's own face name is the same regardless of pair order");
});

// ---------------------------------------------------------------
// classifyJoint() / declareJoint() — the exact contract
// tools/attachTool.js depends on
// ---------------------------------------------------------------
section('classifyJoint / declareJoint — attachTool.js contract', () => {
  const { nodes } = addBox([]);
  const left = nodes.find((n) => n.name === 'Left');
  const top = nodes.find((n) => n.name === 'Top');
  const right = nodes.find((n) => n.name === 'Right');

  // Correct pick: the faces that actually face each other
  const resolved = resolveConstraints(nodes);
  const rLeft = byName(resolved, 'Left');
  const rTop = byName(resolved, 'Top');
  const faceOnLeft = rLeft.position.y < rTop.position.y ? 'top' : 'bottom'; // whichever local face of Left actually points at Top
  const suggestion = classifyJoint(nodes, left.id, faceOnLeft, top.id, faceOnLeft === 'top' ? 'front' : 'back');
  // (faceOnTop derived same way detectJoints derives it — see facingFace; front/back
  // is what Top's rotation maps its Y-facing sides to, confirmed in exploratory run)
  assert(!!suggestion, 'classifyJoint: correct face pair returns a suggestion, not null');
  assertEqual(suggestion?.type, 'corner_butt', 'classifyJoint: Left/Top pick classifies as corner_butt, matching detectJoints');

  // Wrong pick: same axis, but faces that do NOT face each other (both "right")
  const mismatch = classifyJoint(nodes, left.id, 'right', top.id, 'right');
  assertEqual(mismatch, null, 'classifyJoint: mismatched (non-facing) faces return null');

  // Wrong pick: faces on different axes entirely
  const wrongAxis = classifyJoint(nodes, left.id, 'top', right.id, 'left');
  assertEqual(wrongAxis, null, 'classifyJoint: faces on different axes return null');

  // Unrelated, non-touching pair on a valid shared axis (Left vs Right both align to X, but never touch)
  const noContact = classifyJoint(nodes, left.id, 'right', right.id, 'left');
  assertEqual(noContact, null, 'classifyJoint: same-axis but non-touching pair returns null');

  // declareJoint builds the relation shape attachTool.js writes to node.relations
  const relation = declareJoint(left.id, faceOnLeft, top.id, faceOnLeft === 'top' ? 'front' : 'back', suggestion.type, suggestion.params);
  assertEqual(relation.kind, 'joint', 'declareJoint: relation.kind is "joint"');
  assertEqual(relation.jointType, 'corner_butt', 'declareJoint: relation.jointType matches classifyJoint\'s suggestion');
  assertEqual(relation.from.node, left.id, 'declareJoint: relation.from.node is panel A');
  assertEqual(relation.to.node, top.id, 'declareJoint: relation.to.node is panel B');
  assertEqual(relation.locked, false, 'declareJoint: relation starts unlocked');
  assert(typeof relation.id === 'string' && relation.id.length > 0, 'declareJoint: relation has an id');
});

// ---------------------------------------------------------------
// Report layer — summary counts, orphan detection, JSON/text report
// ---------------------------------------------------------------
section('Report — summary, orphan panels, JSON/text output', () => {
  const { allNodes, resolved, joints } = shelfFixture;
  const { collisions } = detectJoints(resolved);

  const report = buildJointsReport(resolved, joints, collisions);
  assertEqual(report.summary.panelCount, 6, 'report: 6 visible panels (box + shelf, Front hidden)');
  assertEqual(report.summary.jointCount, joints.length, 'report: jointCount matches detectJoints output');
  assertEqual(report.summary.byType.corner_butt, 8, 'report: byType counts corner_butt correctly');
  assertEqual(report.summary.byType.t_butt, 3, 'report: byType counts t_butt correctly (Left/Right/Back <-> Shelf)');
  assertEqual(report.summary.byType.near_contact, 0, 'report: byType includes zero-count types explicitly');
  assertEqual(report.summary.collisionCount, 0, 'report: collisionCount matches');
  assertEqual(report.orphanPanels.length, 0, 'report: no orphans in a fully-jointed box+shelf');
  assert(report.joints.every((j) => j.panelAName && j.panelBName), 'report: every joint entry carries panel names, not just ids');

  // Orphan panel detection: a panel with no constraints and no
  // contact with anything else must be flagged.
  const floatingPanel = createPanelNode({ name: 'Floating', width: 100, height: 100, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  floatingPanel.basePosition = { x: 5000, y: 5000, z: 5000 }; // nowhere near the box
  const resolvedWithFloater = resolveConstraints([...allNodes, floatingPanel]);
  const { joints: jointsWithFloater } = detectJoints(resolvedWithFloater);
  const orphans = findOrphanPanels(resolvedWithFloater, jointsWithFloater);
  assertEqual(orphans.length, 1, 'orphan detection: exactly one orphan found');
  assertEqual(orphans[0]?.name, 'Floating', 'orphan detection: correctly identifies the floating panel by name');

  // Text report: attention section only appears when there's something to flag
  const cleanLines = formatJointsReportLines(resolved, joints, collisions);
  assert(!cleanLines.some((l) => l.includes('NEEDS ATTENTION')), 'text report: no attention section when everything is clean');
  assert(cleanLines.some((l) => l.includes('=== SUMMARY ===')), 'text report: summary section always present');

  const { joints: jointsFloater, collisions: collisionsFloater } = detectJoints(resolvedWithFloater);
  const dirtyLines = formatJointsReportLines(resolvedWithFloater, jointsFloater, collisionsFloater);
  assert(dirtyLines.some((l) => l.includes('NEEDS ATTENTION')), 'text report: attention section appears once there is an orphan');
  assert(dirtyLines.some((l) => l.includes('Floating')), 'text report: orphan panel named explicitly in the attention section');
});

// ---------------------------------------------------------------
// Cross-group joints — two independently-built boxes pushed together
// ---------------------------------------------------------------
section('Cross-group — two separate box groups touching', () => {
  const box1 = addBox([]);
  const box2 = addBox([]);
  // Shift every node of box2 by exactly one box-width along X so
  // box2's Left face lands flush against box1's Right face — a
  // deliberate, real contact between two DIFFERENT groups (each
  // addBox() call mints its own groupId — see box.js's own comment on
  // "left's own id doubles as the group's identifier").
  box2.nodes.forEach((n) => { n.basePosition = { ...n.basePosition, x: n.basePosition.x + 500 }; });

  const allNodes = [...box1.nodes, ...box2.nodes];
  const resolved = resolveConstraints(allNodes);
  const { joints, collisions } = detectJoints(resolved);
  assertEqual(collisions.length, 0, 'cross-group fixture: no collisions');

  const crossGroup = findCrossGroupJoints(resolved, joints);
  // Right<->Left (face_to_face) plus the three pairs of panels whose
  // OWN edges happen to coincide exactly at the shared x=500 boundary
  // (Top<->Top, Bottom<->Bottom, Back<->Back, all edge_to_edge) — a
  // real, if slightly surprising, consequence of two identical boxes
  // pushed flush together. Asserting the exact count here (not just
  // ">0") is the point: if this number ever changes, it's because the
  // classification logic changed, and that should be a conscious,
  // reviewed decision.
  assertEqual(crossGroup.length, 4, 'cross-group fixture: exactly 4 cross-group joints detected');
  assert(crossGroup.every((j) => j.panelA && j.panelB), 'cross-group fixture: every cross-group joint has both panel ids');

  const rightLeft = crossGroup.find((j) => {
    const names = [resolved.find((r) => r.id === j.panelA).name, resolved.find((r) => r.id === j.panelB).name];
    return names.includes('Right') && names.includes('Left');
  });
  assert(!!rightLeft, 'cross-group fixture: Right <-> Left found among the cross-group joints');
  assertEqual(rightLeft?.type, 'face_to_face', 'cross-group fixture: Right <-> Left classifies as face_to_face');

  // A within-group joint (e.g. box1's own Left <-> Top) must NOT be flagged cross-group
  const box1Left = resolved.find((r) => r.groupId === box1.groupId && r.name === 'Left');
  const box1Top = resolved.find((r) => r.groupId === box1.groupId && r.name === 'Top');
  const withinGroup = joints.find((j) => (j.panelA === box1Left.id && j.panelB === box1Top.id) || (j.panelA === box1Top.id && j.panelB === box1Left.id));
  assert(!!withinGroup, 'cross-group fixture: box1 Left <-> Top still detected');
  assert(!crossGroup.includes(withinGroup), 'cross-group fixture: box1 Left <-> Top is NOT flagged cross-group');

  const report = buildJointsReport(resolved, joints, collisions);
  assertEqual(report.summary.crossGroupCount, 4, 'report: crossGroupCount matches findCrossGroupJoints');
  assert(report.crossGroupJoints.every((j) => j.panelAName && j.panelBName), 'report: crossGroupJoints entries carry panel names');
  assert(report.joints.filter((j) => j.crossGroup).length === 4, 'report: exactly 4 joints flagged crossGroup:true in the full joints list');

  const lines = formatJointsReportLines(resolved, joints, collisions);
  assert(lines.some((l) => l.includes('CROSS-GROUP')), 'text report: cross-group section appears when a cross-group joint exists');
  assert(lines.some((l) => l.includes('[cross-group]')), 'text report: at least one line tagged [cross-group] in the attention section');
});

// ---------------------------------------------------------------
// computeJointExtremities — reducing a 2D contact footprint down to
// a line segment (two 3D points + length)
// ---------------------------------------------------------------
section('computeJointExtremities — seam endpoints and length', () => {
  const { resolved, joints } = shelfFixture;
  const leftTop = findJoint(joints, resolved, 'Left', 'Top'); // contactAxis 'y', overlap x:[0,18] z:[-200,200]

  const { p1, p2, lengthMm } = computeJointExtremities(leftTop);
  // z is by far the longer footprint axis (400mm vs x's 18mm) -> that's the seam direction;
  // x is held fixed at its own midpoint (9mm — the middle of Left's thickness band);
  // y (the contact axis itself) is fixed at contactPosition for both points.
  assertEqual(p1.y, leftTop.contactPosition, 'extremities: p1.y sits at the contact plane');
  assertEqual(p2.y, leftTop.contactPosition, 'extremities: p2.y sits at the contact plane');
  assertEqual(p1.x, p2.x, 'extremities: the non-seam footprint axis (x) is fixed, not varying, between the two points');
  assert(p1.z !== p2.z, 'extremities: the seam runs along z, the longer footprint axis');
  assertEqual(Math.min(p1.z, p2.z), leftTop.overlap.z[0], 'extremities: one endpoint sits at the footprint\'s z minimum');
  assertEqual(Math.max(p1.z, p2.z), leftTop.overlap.z[1], 'extremities: the other endpoint sits at the footprint\'s z maximum');
  assert(Math.abs(lengthMm - 400) < 1e-6, 'extremities: length matches the 400mm z-overlap span');
  const euclidean = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
  assert(Math.abs(lengthMm - euclidean) < 1e-9, 'extremities: reported length equals the actual Euclidean distance between the two points');
});

// ---------------------------------------------------------------
// PDF table row formatting — formatJointTableRow, used by
// engine/pdfExport.js's Joint ID / Type / Panel 1 ID / Panel 2 ID /
// Axis / Faces / Gap / Point 1 / Point 2 / Length columns
// ---------------------------------------------------------------
section('formatJointTableRow — PDF table cell values', () => {
  const { allNodes, resolved, joints } = shelfFixture;
  const { collisions } = detectJoints(resolved);
  const pieceCodeById = new Map(allNodes.map((n) => [n.id, n.pieceCode]));
  const report = buildJointsReport(resolved, joints, collisions, [], { pieceCodeById });

  const leftTop = findJoint(report.joints, resolved, 'Left', 'Top');
  const row = formatJointTableRow(leftTop);

  assertEqual(row.id, leftTop.displayId, 'table row: id uses the short display id, not the internal panelA:panelB:axis id');
  assert(/^CB\d{3}$/.test(row.id), 'table row: corner_butt display id matches the CB### pattern');
  assertEqual(row.type, 'corner_butt', 'table row: type passes through unchanged');
  assertEqual(row.panelA, pieceCodeById.get(leftTop.panelA), 'table row: panelA shows the cut-list piece code, not the raw node id');
  assertEqual(row.panelB, pieceCodeById.get(leftTop.panelB), 'table row: panelB shows the cut-list piece code');
  assert(/^[A-Z]{2}\d{4}$/.test(row.panelA), 'table row: panel code matches the BA0001-style pattern');
  assertEqual(row.axis, 'Y', 'table row: axis is uppercased');
  assert(row.faces.includes('/'), 'table row: faces combines faceA/faceB with a slash');
  assert(/^-?\d+\.\d$/.test(row.gap), 'table row: gap formatted to one decimal place');
  assert(/^\(-?\d+, -?\d+, -?\d+\)$/.test(row.point1), 'table row: point1 formatted as a whole-mm (x, y, z) triple');
  assert(/^\(-?\d+, -?\d+, -?\d+\)$/.test(row.point2), 'table row: point2 formatted as a whole-mm (x, y, z) triple');
  assertEqual(row.length, '400mm', 'table row: length formatted as whole mm with a unit suffix');

  // Every joint type gets a distinct, uniquely-numbered display id
  const allIds = report.joints.map((j) => j.displayId);
  assertEqual(new Set(allIds).size, allIds.length, 'display ids: every joint in the report has a unique display id');
  assert(allIds.every((id) => /^[A-Z]{2}\d{3}$/.test(id)), 'display ids: every id matches the TT### pattern');
  const tButtIds = report.joints.filter((j) => j.type === 't_butt').map((j) => j.displayId).sort();
  assertEqual(tButtIds.join(','), 'TB001,TB002,TB003', 't_butt: the 3 shelf joints are numbered TB001-TB003');

  // Without a pieceCodeById, panel columns gracefully fall back to name (never a raw internal id)
  const reportNoCodesInput = buildJointsReport(resolved, joints, collisions);
  const leftTopNoCodesInput = findJoint(reportNoCodesInput.joints, resolved, 'Left', 'Top');
  assertEqual(leftTopNoCodesInput.panelACode, byName(resolved, 'Left').name, 'panelACode: falls back to the panel name when no pieceCodeById is supplied');
});

// ---------------------------------------------------------------
// Feature joints — door hinge association
// ---------------------------------------------------------------
section('detectFeatureJoints — door hinge', () => {
  const { nodes: boxNodes } = addBox([]);
  const left = boxNodes.find((n) => n.name === 'Left');
  const right = boxNodes.find((n) => n.name === 'Right');
  const top = boxNodes.find((n) => n.name === 'Top');
  const bottom = boxNodes.find((n) => n.name === 'Bottom');

  const boundaryResult = computeBoundaryRectangle(boxNodes, [left, right, top, bottom]);
  assert(boundaryResult.ok, 'door fixture: boundary rectangle resolves against Left/Right/Top/Bottom');

  const placement = computeDoorPlacement(boxNodes, boundaryResult, DEFAULT_DOOR_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, hinge: 'left' });
  assert(placement.ok, 'door fixture: placement succeeds');
  const doorNode = createDoorNode(boxNodes, placement);

  let panels = [...boxNodes];
  placement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, placement.normalAxis); });
  panels = [...panels, doorNode];

  const featureJoints = detectFeatureJoints(panels);
  assertEqual(featureJoints.length, 1, 'door fixture: exactly one feature joint (the hinge) detected');
  const hinge = featureJoints[0];
  assertEqual(hinge.kind, 'door_hinge', 'door fixture: kind is door_hinge');
  assertEqual(hinge.panelA, doorNode.id, 'door fixture: panelA is the door itself');
  assertEqual(hinge.panelB, left.id, "door fixture: panelB is Left — the hinge:'left' side's boundary panel, not Right/Top/Bottom");
  assertEqual(hinge.side, 'left', 'door fixture: side matches the door\'s own hinge field');
  assertEqual(hinge.axis, 'z', 'door fixture: axis is the door\'s normalAxis (it replaces Back/Front)');
  assert(Math.abs(hinge.lengthMm - doorNode.height) < 1e-6, 'door fixture: hinge length equals the door\'s own height');
  assertEqual(hinge.p1.x, hinge.p2.x, 'door fixture: both hinge endpoints sit on the same (hinge-side) X coordinate');
  assertEqual(hinge.p1.z, hinge.p2.z, 'door fixture: both hinge endpoints sit at the same depth (the door\'s own thickness position)');
  assert(hinge.p1.y !== hinge.p2.y, 'door fixture: the hinge line runs vertically (varies in Y)');

  // Flip the hinge to the other side — the association must follow, not stay pinned to 'left'
  const placementRight = computeDoorPlacement(boxNodes, boundaryResult, DEFAULT_DOOR_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, hinge: 'right' });
  const doorNodeRight = createDoorNode(boxNodes, placementRight);
  let panelsRight = [...boxNodes];
  placementRight.panelPatches.forEach((patch) => { panelsRight = applyPanelPatch(panelsRight, patch, placementRight.normalAxis); });
  panelsRight = [...panelsRight, doorNodeRight];
  const hingeRight = detectFeatureJoints(panelsRight)[0];
  assertEqual(hingeRight.panelB, right.id, "door fixture: hinge:'right' correctly associates with Right instead of Left");

  // A door with no hinge/boundaryIds data at all must produce nothing, not throw
  const bareDoor = createPanelNode({ name: 'Door', width: 100, height: 100, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
  bareDoor.isDoor = true;
  assertEqual(detectFeatureJoints([...boxNodes, bareDoor]).length, 0, 'door fixture: a door with no hinge/boundaryIds produces no feature joint');
});

// ---------------------------------------------------------------
// Feature joints — drawer slide association
// ---------------------------------------------------------------
let drawerFixture;
section('detectFeatureJoints — drawer slide', () => {
  const { nodes: boxNodes } = addBox([]);
  const left = boxNodes.find((n) => n.name === 'Left');
  const right = boxNodes.find((n) => n.name === 'Right');
  const top = boxNodes.find((n) => n.name === 'Top');
  const bottom = boxNodes.find((n) => n.name === 'Bottom');

  const boundaryResult = computeBoundaryRectangle(boxNodes, [left, right, top, bottom]);
  const frontsPlacement = computeDrawerFrontsPlacement(boxNodes, boundaryResult, DEFAULT_DRAWER_EDGE_FIT, { material: 'Melamine White 18mm', thicknessMm: 18, count: 1 });
  assert(frontsPlacement.ok, 'drawer fixture: front placement succeeds');
  const frontNodes = createDrawerFrontNodes(boxNodes, frontsPlacement, {});

  let panels = [...boxNodes];
  frontsPlacement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, frontsPlacement.normalAxis); });
  panels = [...panels, ...frontNodes];

  const frontNode = frontNodes[0];
  const boxPlacement = computeDrawerBoxPlacement(panels, frontNode, { material: 'Melamine White 18mm', thicknessMm: 18 });
  assert(boxPlacement.ok, 'drawer fixture: box placement succeeds');
  const drawerBoxNodes = createDrawerBoxNodes(panels, boxPlacement);
  panels = [...panels, ...drawerBoxNodes];
  drawerFixture = { panels, frontNode, drawerBoxNodes, left, right };

  const featureJoints = detectFeatureJoints(panels);
  assertEqual(featureJoints.length, 2, 'drawer fixture: exactly 2 feature joints (box left + box right)');
  assert(featureJoints.every((j) => j.kind === 'drawer_slide'), 'drawer fixture: both are drawer_slide');

  const boxLeft = drawerBoxNodes.find((n) => n.drawerBoxRole === 'left');
  const boxRight = drawerBoxNodes.find((n) => n.drawerBoxRole === 'right');
  const leftSlide = featureJoints.find((j) => j.panelA === boxLeft.id);
  const rightSlide = featureJoints.find((j) => j.panelA === boxRight.id);

  assertEqual(leftSlide.panelB, left.id, 'drawer fixture: Drawer Left associates with the carcass Left panel, not Right');
  assertEqual(rightSlide.panelB, right.id, 'drawer fixture: Drawer Right associates with the carcass Right panel, not Left');
  assertEqual(leftSlide.side, 'left', 'drawer fixture: side field matches');
  assertEqual(rightSlide.side, 'right', 'drawer fixture: side field matches');

  const resolvedBoxLeft = resolveConstraints(panels).find((r) => r.id === boxLeft.id);
  assert(Math.abs(leftSlide.lengthMm - resolvedBoxLeft.width) < 1e-6, "drawer fixture: slide length equals the drawer box side panel's own depth (its 'width' field, given its rotation)");
  assertEqual(leftSlide.p1.x, leftSlide.p2.x, 'drawer fixture: both slide endpoints sit at the same X (the drawer box side\'s own position)');
  assert(leftSlide.p1.z !== leftSlide.p2.z, 'drawer fixture: the slide run varies along Z (depth), matching the front\'s normalAxis');

  // Deliberately NOT geometrically touching — this is the whole point (see detectFeatureJoints's
  // own doc comment): there's a real clearance gap for the slide hardware, so detectJoints's
  // own AABB contact test must find NOTHING between these two panels.
  const resolvedAll = resolveConstraints(panels);
  const { joints: geometricJoints } = detectJoints(resolvedAll);
  const geometricLeftSlide = geometricJoints.find((j) => (j.panelA === boxLeft.id && j.panelB === left.id) || (j.panelA === left.id && j.panelB === boxLeft.id));
  assert(!geometricLeftSlide, 'drawer fixture: detectJoints finds NO geometric contact between the drawer box side and the carcass side (real clearance gap)');
});

// ---------------------------------------------------------------
// Feature joints in the report/PDF layer
// ---------------------------------------------------------------
section('Feature joints — report integration', () => {
  const { panels, left, right } = drawerFixture;
  const resolved = resolveConstraints(panels);
  const { joints, collisions } = detectJoints(resolved);
  const featureJoints = detectFeatureJoints(panels);
  const pieceCodeById = new Map(panels.map((p) => [p.id, p.pieceCode]));

  const reportData = buildJointsReport(resolved, joints, collisions, featureJoints, { pieceCodeById });
  assertEqual(reportData.summary.featureJointCount, 2, 'report: featureJointCount matches detectFeatureJoints output');
  assertEqual(reportData.summary.drawerSlideCount, 2, 'report: drawerSlideCount is 2, doorHingeCount is 0');
  assertEqual(reportData.summary.doorHingeCount, 0, 'report: doorHingeCount is 0 for a drawer-only fixture');
  assert(reportData.featureJoints.every((j) => /^DS\d{3}$/.test(j.displayId)), 'report: drawer_slide feature joints get DS### display ids');
  assert(reportData.featureJoints.every((j) => j.panelAName && j.panelBName), 'report: feature joints carry panel names');
  assert(reportData.featureJoints.every((j) => j.panelACode && j.panelBCode), 'report: feature joints carry panel codes when pieceCodeById is supplied');

  const row = formatFeatureJointTableRow(reportData.featureJoints[0]);
  assert(/^DS\d{3}$/.test(row.id), 'feature table row: id matches the DS### pattern');
  assertEqual(row.kind, 'drawer_slide', 'feature table row: kind passes through');
  assert(/^[A-Z]{2}\d{4}$/.test(row.panelA), 'feature table row: panelA uses the piece-code pattern');
  assert(/^\(-?\d+, -?\d+, -?\d+\)$/.test(row.point1), 'feature table row: point1 formatted as a whole-mm triple');
  assert(row.length.endsWith('mm'), 'feature table row: length has an mm suffix');

  const lines = formatJointsReportLines(resolved, joints, collisions, featureJoints);
  assert(lines.some((l) => l.includes('DOOR HINGES / DRAWER SLIDES')), 'text report: feature-joints section appears when feature joints exist');
  assert(lines.some((l) => l.includes('drawer_slide')), 'text report: at least one drawer_slide line present');
});

report();

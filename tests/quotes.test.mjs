/**
 * tests/quotes.test.mjs
 *
 * Covers the `distance` constraint (modeller/snap.js), panel ownership
 * (modeller/modules.js) and the quote write path (engine/quotes.js):
 * a quote moves a panel but never resizes it; system-owned panels
 * (plinth, box walls) can anchor a quote but never be driven by one.
 *
 * Run with: node tests/quotes.test.mjs
 */
import { assert, assertEqual, section, report, ensureMaterialCatalog } from './helpers.mjs';
import { addBox } from '../src/features/box.js';
import { computePlinthPlacement, createPlinthNodes } from '../src/features/plinth.js';
import { createPanelNode, getPanelOwnership, isSystemManaged } from '../src/modeller/modules.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import { HORIZONTAL_ROTATION } from '../src/shared/geometry.js';
import * as THREE from 'three';
import { computeDimensionSpecs, computeCandidateSpecs, candidateSpecForPair, specGeometry, projectSpec, dragToOffsetMm, FONT_PX, ARROW_PX } from '../src/modeller/dimensions.js';
import { findQuoteConflicts } from '../src/engine/quoteConflicts.js';
import { validateDesign } from '../src/engine/validator.js';
import { detectJoints } from '../src/engine/joints.js';
import { planDimension, setQuoteOffset, previewQuote, resolveFacingFaces, planBoxDimension, boxDimensionOffset, previewBoxDimension } from '../src/engine/quotes.js';
import { relayoutBox } from '../src/features/box.js';
import { addQuote, updateQuote, removeQuote, measureGap, canBeDriven } from '../src/engine/quotes.js';

await ensureMaterialCatalog();

const res = (panels, id) => resolveConstraints(panels).find((r) => r.id === id);
const wall = (nodes, name) => nodes.find((n) => n.name?.toLowerCase().includes(name));

function boxWithShelf() {
  const { nodes, groupId } = addBox([]);
  const shelf = createPanelNode({
    name: 'Shelf', rotation: HORIZONTAL_ROTATION, width: 400, height: 300,
    basePosition: { x: 250, y: 0, z: 0 }, offset: { x: 0, y: 0, z: 0 },
    lockedMoveAxes: ['x', 'z'],
  });
  return { panels: [...nodes, shelf], shelf, nodes, groupId, bottom: wall(nodes, 'bottom') };
}

section('ownership — derived from existing feature flags', () => {
  const { nodes, shelf } = boxWithShelf();
  assertEqual(getPanelOwnership(shelf).ownership, 'user', 'plain shelf is user-owned');
  assert(nodes.every((n) => isSystemManaged(n)), 'every box wall is system-owned');
  assertEqual(getPanelOwnership(nodes[0]).reason, 'box-wall', 'reason names the feature');
  assertEqual(getPanelOwnership({ isPlinthPanel: true }).reason, 'plinth', 'plinth flag => system');
  assertEqual(getPanelOwnership({ ownership: 'system' }).ownership, 'system', 'explicit value wins');
  assertEqual(shelf.ownership, 'user', 'createPanelNode stamps ownership');
});

section('addQuote — moves position, never size', () => {
  const { panels, shelf, bottom } = boxWithShelf();
  const gap0 = measureGap(panels, shelf.id, 'front', { node: bottom.id, face: 'back' });
  assert(gap0 !== null, 'measureGap works for facing faces');
  const sizeBefore = res(panels, shelf.id);
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: { node: bottom.id, face: 'back' }, value: 250 });
  assert(r.ok, `quote accepted (${r.message || ''})`);
  const after = res(r.panels, shelf.id);
  assertEqual(Math.round(measureGap(r.panels, shelf.id, 'front', { node: bottom.id, face: 'back' })), 250, 'resulting gap is 250 mm');
  assertEqual(after.width, sizeBefore.width, 'width unchanged');
  assertEqual(after.height, sizeBefore.height, 'height unchanged');
  assertEqual(after.thickness, sizeBefore.thickness, 'thickness unchanged');
  assert(after.lockedFields.positionY, 'driven axis is locked');

  const u = updateQuote(r.panels, shelf.id, r.constraint.id, 300);
  assert(u.ok, 'updateQuote ok');
  assertEqual(Math.round(measureGap(u.panels, shelf.id, 'front', { node: bottom.id, face: 'back' })), 300, 'updated to 300 mm');

  const rm = removeQuote(u.panels, shelf.id, r.constraint.id);
  assert(rm.ok, 'removeQuote ok');
  assertEqual(Math.round(res(rm.panels, shelf.id).position.y), Math.round(res(u.panels, shelf.id).position.y), 'panel stays put after removal');
});

section('addQuote — guards', () => {
  const { panels, shelf, bottom, nodes } = boxWithShelf();
  const top = wall(nodes, 'top');
  const q = (o) => addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: { node: bottom.id, face: 'back' }, value: 100, ...o });
  assertEqual(q({ value: -5 }).reason, 'bad-value', 'negative distance rejected');
  assertEqual(q({ myFace: 'back' }).reason, 'not-facing', 'faces that do not face each other rejected');
  assertEqual(q({ drivenId: bottom.id, from: { node: shelf.id, face: 'front' }, myFace: 'back' }).reason, 'system-owned', 'box wall can not be driven');
  assertEqual(addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: { node: shelf.id, face: 'back' }, value: 1 }).reason, 'same-panel', 'same panel rejected');
  const first = q({});
  assert(first.ok, 'first quote ok');
  assertEqual(addQuote(first.panels, { drivenId: shelf.id, myFace: 'back', from: { node: top.id, face: 'front' }, value: 50 }).reason, 'already-driven', 'second quote on same axis rejected');
});

section('plinth — can anchor a quote but is never driven', () => {
  const { nodes, groupId } = addBox([]);
  const placement = computePlinthPlacement(nodes, groupId, {});
  const plinth = createPlinthNodes(nodes, placement);
  const shelf = createPanelNode({ name: 'Shelf', rotation: HORIZONTAL_ROTATION, width: 300, height: 200, lockedMoveAxes: ['x', 'z'] });
  const panels = [...nodes, ...plinth, shelf];
  const rib = plinth.find((n) => n.isPlinthRib) || plinth[0];
  assert(plinth.every((n) => isSystemManaged(n)), 'all plinth panels are system-owned');
  assertEqual(canBeDriven(plinth[0], 'y').reason, 'system-owned', 'canBeDriven refuses plinth');
  const back = plinth.find((n) => n.plinthRole === 'back');
  const r = addQuote(panels, { drivenId: back.id, myFace: 'top', from: { node: shelf.id, face: 'front' }, value: 10 });
  assertEqual(r.reason, 'system-owned', 'quote driving a plinth panel rejected');
  const ok = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: { node: back.id, face: 'top' }, value: 100 });
  assert(ok.ok, `plinth panel accepted as anchor (${ok.message || ''})`);
});

section('computeDimensionSpecs — geometry of the annotation', () => {
  const { panels, shelf, bottom } = boxWithShelf();
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: { node: bottom.id, face: 'back' }, value: 250 });
  const specs = computeDimensionSpecs(r.panels, resolveConstraints(r.panels));
  assertEqual(specs.length, 1, 'one spec per active quote');
  const sp = specs[0];
  assertEqual(sp.axis, 'y', 'vertical quote');
  assertEqual(Math.round(Math.abs(sp.to.y - sp.from.y)), 250, 'line length equals the quoted distance');
  assert(sp.ok, 'satisfied quote is flagged ok');
  assertEqual(sp.label, '250 mm', 'label text');
  const frontMost = Math.max(...resolveConstraints(r.panels).map((p) => p.position.z + p.thickness));
  assert(sp.from.z > resolveConstraints(r.panels).find((p) => p.id === shelf.id).position.z, 'line sits in front of the panels');
  // an overridden quote draws nothing
  const off = r.panels.map((p) => (p.id === shelf.id ? { ...p, constraints: p.constraints.map((c) => ({ ...c, overridden: true })) } : p));
  assertEqual(computeDimensionSpecs(off, resolveConstraints(off)).length, 0, 'unlinked quote not drawn');
});

const kinds = (vs) => vs.map((v) => v.kind).sort();
const front = (id, face) => ({ node: id, face });

section('findQuoteConflicts — clean design reports nothing', () => {
  const { panels, shelf, bottom } = boxWithShelf();
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 150 });
  assertEqual(findQuoteConflicts(r.panels, resolveConstraints(r.panels)).length, 0, 'no conflicts for a valid quote');
  assertEqual(findQuoteConflicts(panels, resolveConstraints(panels)).length, 0, 'no quotes, no conflicts');
});

section('findQuoteConflicts — overDriven (two relations on one position)', () => {
  const { panels, shelf, bottom, nodes } = boxWithShelf();
  const top = wall(nodes, 'top');
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 150 });
  // simulate a design loaded with a second quote on the same axis (addQuote itself would refuse it)
  const second = { ...r.constraint, id: 'cX', myFace: 'back', from: front(top.id, 'front'), value: 100 };
  const bad = r.panels.map((p) => (p.id === shelf.id ? { ...p, constraints: [...p.constraints, second] } : p));
  const vs = findQuoteConflicts(bad, resolveConstraints(bad));
  assert(kinds(vs).includes('overDriven'), 'overDriven reported');
  assert(vs[0].drivenIds.includes(shelf.id), 'names the quoted panel');
});

section('findQuoteConflicts — system panel / locked axis / missing anchor', () => {
  const { panels, shelf, bottom, nodes } = boxWithShelf();
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 150 });
  const q = r.constraint;
  const onWall = r.panels.map((p) => (p.id === bottom.id ? { ...p, constraints: [{ ...q, from: front(shelf.id, 'front'), myFace: 'back' }] } : p));
  assert(kinds(findQuoteConflicts(onWall, resolveConstraints(onWall))).includes('systemDriven'), 'quote on a system panel flagged');
  const locked = r.panels.map((p) => (p.id === shelf.id ? { ...p, lockedMoveAxes: ['x', 'y', 'z'] } : p));
  assert(kinds(findQuoteConflicts(locked, resolveConstraints(locked))).includes('axisLocked'), 'locked axis flagged');
  const gone = r.panels.filter((p) => p.id !== bottom.id);
  const vs = findQuoteConflicts(gone, resolveConstraints(gone));
  assert(kinds(vs).includes('unresolved'), 'deleted anchor flagged as unresolved');
});

section('findQuoteConflicts + validateDesign — a quote that does not fit the space', () => {
  const { panels, shelf, bottom } = boxWithShelf();
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 150 });
  const tooHigh = updateQuote(r.panels, shelf.id, r.constraint.id, 5000); // far above the box top
  assert(tooHigh.ok, 'updateQuote itself does not block (detect and surface)');
  const resolved = resolveConstraints(tooHigh.panels);
  const { collisions } = detectJoints(resolved);
  const vs = findQuoteConflicts(tooHigh.panels, resolved, { collisions });
  assert(vs.some((v) => v.kind === 'overflow'), 'overflow reported');
  const all = validateDesign(tooHigh.panels, resolved, { collisions }).violations;
  assert(all.some((v) => v.type === 'quoteConflict'), 'validateDesign includes quote conflicts');
  const explained = new Set(vs.flatMap((v) => v.explains || []));
  assert(all.every((v) => !explained.has(v.key)), 'generic violations explained by a quote are not listed twice');

  // a quote that fits that same space overlaps nothing
  const fits = resolveConstraints(r.panels);
  const ok = validateDesign(r.panels, fits, { collisions: detectJoints(fits).collisions }).violations;
  assert(ok.every((v) => v.type !== 'quoteConflict'), 'a fitting quote raises no quote conflict');
});

section('previewQuote — live feedback while typing', () => {
  const { panels, shelf, bottom } = boxWithShelf();
  const spec = (value) => ({ drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value });
  const fits = previewQuote(panels, spec(150));
  assert(fits.ok && fits.conflicts.length === 0, 'a fitting value previews clean');
  const tooHigh = previewQuote(panels, spec(5000));
  assert(tooHigh.ok && tooHigh.conflicts.length > 0, 'a too-large value previews its conflicts');
  const negative = previewQuote(panels, spec(-3));
  assert(!negative.ok && negative.blocking, 'a refused value previews the blocking reason');
  assertEqual(panels.find((p) => p.id === shelf.id).constraints.length, 0, 'preview never changes the graph');
  // conflicts that already existed are not blamed on the new value
  const base = addQuote(panels, spec(5000));
  const again = previewQuote(base.panels.map((p) => (p.id === shelf.id ? { ...p, constraints: [] } : p)), spec(150));
  assert(again.ok && again.conflicts.length === 0, 'preview after clearing is clean');
});

section('resolveFacingFaces — clicks on outer surfaces (same direction)', () => {
  const base = boxWithShelf();
  const { shelf, bottom, nodes } = base;
  const panels = base.panels.map((p) => (p.id === shelf.id ? { ...p, offset: { x: 0, y: 200, z: 0 } } : p)); // shelf floating above the Bottom
  const top = wall(nodes, 'top');
  const pick = (id, faceName) => ({ nodeId: id, faceName });
  // top surface of the shelf + top surface of the Bottom: both point UP
  const sameDir = resolveFacingFaces(panels, pick(shelf.id, 'back'), pick(bottom.id, 'back'));
  assert(sameDir.ok && sameDir.corrected, 'same-direction picks are corrected');
  const onShelf = [sameDir.a, sameDir.b].find((f) => f.nodeId === shelf.id);
  const onBottom = [sameDir.a, sameDir.b].find((f) => f.nodeId === bottom.id);
  assertEqual(onShelf.faceName, 'front', 'shelf underside chosen');
  assertEqual(onBottom.faceName, 'back', 'Bottom upper face chosen');
  const q = addQuote(panels, { drivenId: shelf.id, myFace: onShelf.faceName, from: { node: bottom.id, face: onBottom.faceName }, value: 100 });
  assert(q.ok, `corrected faces produce an acceptable quote (${q.message || ''})`);
  // already-facing picks are kept as they are
  const facing = resolveFacingFaces(panels, pick(bottom.id, 'back'), pick(shelf.id, 'front'));
  assert(facing.ok && !facing.corrected, 'already-facing picks are not altered');
  // picks on the wrong (outer) faces still resolve to the inner gap
  const reversed = resolveFacingFaces(panels, pick(shelf.id, 'front'), pick(bottom.id, 'front'));
  assert(reversed.ok && reversed.corrected, 'outer-face picks resolve to the facing pair');
  // the panel above
  assert(resolveFacingFaces(panels, pick(shelf.id, 'back'), pick(top.id, 'back')).ok, 'works for the panel above too');
  // overlapping panels have no gap to dimension
  const overlap = resolveFacingFaces(base.panels, pick(shelf.id, 'back'), pick(bottom.id, 'back'));
  assert(!overlap.ok && overlap.reason === 'overlap', 'overlapping panels are refused with a reason');
  // perpendicular picks are refused with an explanation
  const perp = resolveFacingFaces(panels, pick(shelf.id, 'back'), pick(wall(nodes, 'left').id, 'right'));
  assert(!perp.ok && perp.reason === 'not-parallel', 'perpendicular faces are refused');
});

section('box dimensions — two walls of one box set its OUTSIDE size', () => {
  const { nodes, groupId } = addBox([]);
  const w = (n) => wall(nodes, n);
  const pick = (id, faceName) => ({ nodeId: id, faceName });
  const interior = (panels, a, b, axis) => {
    const r = new Map(resolveConstraints(panels).map((x) => [x.id, x]));
    return Math.abs(r.get(a.id).position[axis] - r.get(b.id).position[axis]) + (r.get(a.id).thickness + r.get(b.id).thickness) / 2; // outer-to-outer
  };
  // click the outer surfaces of Left and Right (width), Top and Bottom (height), Back and Front (depth)
  const cases = [['left', 'right', 'x', 'width', 700], ['bottom', 'top', 'y', 'height', 500], ['back', 'front', 'z', 'depth', 300]];
  cases.forEach(([n1, n2, axis, label, target]) => {
    const A = w(n1), B = w(n2);
    const faces = resolveFacingFaces(nodes, pick(A.id, 'front'), pick(B.id, 'front'));
    const aF = faces.ok ? faces.a : null;
    // use whichever faces the resolver found; if the two walls are not parallel on 'front', fall back to brute force over face names
    let plan = null, fa = null, fb = null;
    for (const f1 of ['front', 'back', 'top', 'bottom', 'left', 'right']) for (const f2 of ['front', 'back', 'top', 'bottom', 'left', 'right']) {
      if (plan) break;
      const rf = resolveFacingFaces(nodes, pick(A.id, f1), pick(B.id, f2));
      if (rf.ok) { const p = planBoxDimension(nodes, rf.a, rf.b); if (p && p.axis === axis) { plan = p; fa = rf.a; fb = rf.b; } }
    }
    assert(plan && plan.label === label, `${n1}/${n2}: box dimension recognised as ${label}`);
    const before = interior(nodes, A, B, axis);
    assertEqual(Math.round(plan.measuredMm), Math.round(before), `${label}: measured outer size matches geometry`);
    const offset = boxDimensionOffset(nodes, plan, target);
    const moved = nodes.map((p) => (p.id === plan.moveId ? { ...p, offset } : p));
    const rl = relayoutBox(moved, groupId);
    assert(rl.ok, `${label}: relayoutBox accepts ${target} mm`);
    const applied = moved.map((p) => { const patch = rl.patches.find((x) => x.id === p.id); return patch ? { ...p, width: patch.width, height: patch.height, offset: patch.offset } : p; });
    assertEqual(Math.round(interior(applied, A, B, axis)), target, `${label}: outer size becomes exactly ${target} mm`);
    assert(previewBoxDimension(nodes, plan, target).ok, `${label}: preview ok`);
  });
  const w1 = w('left'), w2 = w('right');
  let plan = null;
  for (const f1 of ['front', 'back', 'top', 'bottom', 'left', 'right']) for (const f2 of ['front', 'back', 'top', 'bottom', 'left', 'right']) { if (plan) break; const rf = resolveFacingFaces(nodes, pick(w1.id, f1), pick(w2.id, f2)); if (rf.ok) plan = planBoxDimension(nodes, rf.a, rf.b); }
  assert(!previewBoxDimension(nodes, plan, 0).ok, 'zero interior refused');
  assert(!previewBoxDimension(nodes, plan, 99999).ok, 'beyond the design limits refused with a reason');
  // a shelf and a wall are NOT a box dimension (ordinary quote rules apply)
  const { panels, shelf, bottom } = boxWithShelf();
  const rf = resolveFacingFaces(panels.map((p) => (p.id === shelf.id ? { ...p, offset: { x: 0, y: 200, z: 0 } } : p)), pick(shelf.id, 'back'), pick(bottom.id, 'back'));
  assertEqual(planBoxDimension(panels, rf.a, rf.b), null, 'shelf + wall is not a box dimension');
});

section('dimension lines — default position, offset, extension lines', () => {
  const { panels, shelf, bottom } = boxWithShelf();
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 250 });
  const resolved = resolveConstraints(r.panels);
  const rs = new Map(resolved.map((p) => [p.id, p]));
  const sp = computeDimensionSpecs(r.panels, resolved)[0];
  assertEqual(sp.perp, 'x', 'a vertical quote slides along X');
  const rightMost = Math.max(rs.get(shelf.id).position.x + rs.get(shelf.id).width / 2, rs.get(bottom.id).position.x + rs.get(bottom.id).width / 2);
  assert(sp.from.x > rightMost, 'by default the dimension line sits OUTSIDE the panels, not on top of them');
  assert(sp.ext.length > 0, 'extension lines connect the panel edges to the dimension line');
  assertEqual(sp.offsetMm, 0, 'no stored offset yet');

  const moved = setQuoteOffset(r.panels, shelf.id, r.constraint.id, 120);
  assert(moved.ok, 'setQuoteOffset ok');
  const sp2 = computeDimensionSpecs(moved.panels, resolveConstraints(moved.panels))[0];
  assertEqual(Math.round(sp2.from.x - sp.from.x), 120, 'the stored offset shifts the line by 120 mm');
  assertEqual(Math.round(Math.abs(sp2.to.y - sp2.from.y)), 250, 'shifting never changes the quoted distance');
  assertEqual(res(moved.panels, shelf.id).position.y, res(r.panels, shelf.id).position.y, 'shifting never moves a panel');
  const inside = specGeometry(sp, 250 - sp.autoPerpMm); // line at x=250, the middle of both panels
  assertEqual(inside.ext.length, 0, 'no extension lines when the line is inside the panels');
  assert(!setQuoteOffset(r.panels, shelf.id, r.constraint.id, NaN).ok, 'invalid offset refused');
});

section('dimension lines — constant screen size, drag follows the cursor at any zoom', () => {
  const { panels, shelf, bottom } = boxWithShelf();
  const r = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 250 });
  const sp = computeDimensionSpecs(r.panels, resolveConstraints(r.panels))[0];
  assert(FONT_PX > 0 && ARROW_PX > 0, 'text and arrow sizes are fixed pixel constants (no zoom input)');
  const W = 800, H = 600;
  const ortho = (half) => { const c = new THREE.OrthographicCamera(-half * W / H, half * W / H, half, -half, 0.1, 100); c.position.set(0, 0, 10); c.lookAt(0, 0, 0); c.updateMatrixWorld(); c.updateProjectionMatrix(); return c; };
  const far = projectSpec(sp, ortho(2), W, H);
  const near = projectSpec(sp, ortho(1), W, H);
  const len = (L) => Math.hypot(L.p2.x - L.p1.x, L.p2.y - L.p1.y);
  assert(len(near) > len(far) * 1.9, 'zooming in makes the line longer on screen');
  [far, near].forEach((L, i) => {
    const px = 40; // drag the line 40 px to the right
    const mm = dragToOffsetMm({ x: px, y: 0 }, L.axisVec, 100);
    const after = projectSpec(sp, i === 0 ? ortho(2) : ortho(1), W, H, sp.offsetMm + mm);
    assertEqual(Math.round(after.p1.x - L.p1.x), px, `drag of ${px}px moves the line exactly ${px}px on screen (zoom ${i === 0 ? 'out' : 'in'})`);
  });
  assertEqual(dragToOffsetMm({ x: 10, y: 10 }, { x: 0, y: 0 }), 0, 'axis along the view direction cannot be dragged');
  const persp = new THREE.PerspectiveCamera(45, W / H, 0.1, 100); persp.position.set(1, 1, 3); persp.lookAt(0, 0.5, 0); persp.updateMatrixWorld(); persp.updateProjectionMatrix();
  const P = projectSpec(sp, persp, W, H);
  assert(!P.behind && Number.isFinite(P.p1.x), 'works with the perspective camera as well');
});

section('candidates — grey measured dimensions for every neighbouring pair', () => {
  const base = boxWithShelf();
  const { shelf, bottom, nodes } = base;
  const panels = base.panels.map((p) => (p.id === shelf.id ? { ...p, offset: { x: 0, y: 200, z: 0 } } : p));
  const resolved = resolveConstraints(panels);
  const rs = new Map(resolved.map((r) => [r.id, r]));
  const cands = computeCandidateSpecs(panels, resolved, []);
  const find = (idA, idB) => cands.find((c) => c.id.startsWith(`cand:${idA}|${idB}|`));
  const top = wall(nodes, 'top');
  const gapBelow = find(bottom.id, shelf.id);
  assert(gapBelow, 'a candidate between the Bottom and the shelf above it');
  const expected = (rs.get(shelf.id).position.y - rs.get(shelf.id).thickness / 2) - (rs.get(bottom.id).position.y + rs.get(bottom.id).thickness / 2);
  assertEqual(Math.round(gapBelow.valueMm), Math.round(expected), 'its value is the instantaneous gap');
  assert(find(shelf.id, top.id), 'a candidate between the shelf and the Top above it');
  const kinds = new Set(cands.map((c) => c.kind));
  assert(kinds.size === 1 && kinds.has('candidate'), 'all are marked as candidates (not imposed)');
  // the box interior is offered through the walls pass, even with a shelf in between
  const L = wall(nodes, 'left'), R = wall(nodes, 'right');
  assert(find(L.id, R.id), 'interior width: Left-Right');
  assert(find(bottom.id, top.id), 'interior height: Bottom-Top (the shelf in between does not hide it)');
  const backW = wall(nodes, 'back'), frontW = wall(nodes, 'front');
  assert(!find(backW.id, frontW.id), 'no depth candidate while the Front wall is hidden (open front)');
  const shown = panels.map((p) => (p.id === frontW.id ? { ...p, hidden: false } : p));
  assert(computeCandidateSpecs(shown, resolveConstraints(shown), []).some((c) => c.id.startsWith(`cand:${backW.id}|${frontW.id}|`)), 'interior depth: Back-Front once the Front wall is shown');
  // faces of a candidate are really facing, and plan to the right kind of dimension
  const p1 = planDimension(panels, gapBelow.faceA, gapBelow.faceB);
  assert(p1.ok && p1.mode === 'quote', 'shelf/Bottom candidate plans an ordinary quote');
  assertEqual(p1.drivenId, shelf.id, 'the shelf is the panel that moves');
  const lr = find(L.id, R.id);
  const p2 = planDimension(panels, lr.faceA, lr.faceB);
  assert(p2.ok && p2.mode === 'box', 'Left-Right candidate plans a box resize');
  // an imposed quote replaces its grey candidate
  const q = addQuote(panels, { drivenId: shelf.id, myFace: gapBelow.faceB.faceName, from: { node: bottom.id, face: gapBelow.faceA.faceName }, value: 150 });
  assert(q.ok, 'candidate faces produce an acceptable quote');
  const rq = resolveConstraints(q.panels);
  const imposed = computeDimensionSpecs(q.panels, rq);
  assertEqual(imposed[0].kind, 'imposed', 'imposed specs are marked imposed');
  assert(!computeCandidateSpecs(q.panels, rq, imposed).some((c) => c.id.startsWith(`cand:${bottom.id}|${shelf.id}|`)), 'the covered pair no longer has a grey candidate');
  // the pair just picked can be drawn on its own
  const one = candidateSpecForPair(resolved, gapBelow.faceA, gapBelow.faceB);
  assertEqual(one.id, gapBelow.id, 'candidateSpecForPair matches the generated candidate');
  // system panels (plinth, legs, doors...) are never offered
  const plinthPanels = [...panels, createPanelNode({ name: 'Plinth Back', isPlinthPanel: true, rotation: HORIZONTAL_ROTATION, width: 300, height: 100, basePosition: { x: 250, y: -80, z: 0 } })];
  assert(!computeCandidateSpecs(plinthPanels, resolveConstraints(plinthPanels), []).some((c) => c.title.includes('Plinth')), 'system-managed panels are left out');
});

section('planDimension — a box wall only moves when it is the only solution', () => {
  const base = boxWithShelf();
  const { shelf, bottom, nodes } = base;
  const top = wall(nodes, 'top');
  const panels = base.panels.map((p) => (p.id === shelf.id ? { ...p, offset: { x: 0, y: 200, z: 0 } } : p));
  const pick = (id, faceName) => ({ nodeId: id, faceName });
  const facing = (A, B) => resolveFacingFaces(panels, pick(A.id, 'back'), pick(B.id, 'back'));
  // free shelf + Top wall, in BOTH selection orders: the shelf moves, never the wall
  [[shelf, top], [top, shelf]].forEach(([A, B], i) => {
    const f = facing(A, B);
    const plan = planDimension(panels, f.a, f.b);
    assert(plan.ok && plan.mode === 'quote', `order ${i + 1}: an ordinary quote`);
    assertEqual(plan.drivenId, shelf.id, `order ${i + 1}: the shelf is the panel that moves`);
  });
  // shelf already fixed by a quote from the Bottom: now the Top wall is the only solution
  const fixed = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 200 });
  assert(fixed.ok, 'shelf fixed 200 mm above the Bottom');
  [[shelf, top], [top, shelf]].forEach(([A, B], i) => {
    const f = resolveFacingFaces(fixed.panels, pick(A.id, 'back'), pick(B.id, 'back'));
    const plan = planDimension(fixed.panels, f.a, f.b);
    assert(plan.ok && plan.mode === 'box' && plan.plan.kind === 'wall-move', `fixed shelf, order ${i + 1}: the box wall moves instead`);
    assertEqual(plan.plan.moveId, top.id, `fixed shelf, order ${i + 1}: it is the Top wall that moves`);
    assert(/fixed/.test(plan.notice), 'the person is told why');
    const target = 120;
    assert(previewBoxDimension(fixed.panels, plan.plan, target).ok, 'the wall move is accepted by relayoutBox');
    const offset = boxDimensionOffset(fixed.panels, plan.plan, target);
    const moved = fixed.panels.map((p) => (p.id === top.id ? { ...p, offset } : p));
    const rl = relayoutBox(moved, top.groupId);
    const applied = moved.map((p) => { const patch = rl.patches.find((x) => x.id === p.id); return patch ? { ...p, width: patch.width, height: patch.height, offset: patch.offset } : p; });
    const rs = new Map(resolveConstraints(applied).map((r) => [r.id, r]));
    const gap = (rs.get(top.id).position.y - rs.get(top.id).thickness / 2) - (rs.get(shelf.id).position.y + rs.get(shelf.id).thickness / 2);
    assertEqual(Math.round(gap), target, `fixed shelf, order ${i + 1}: the gap becomes ${target} mm`);
  });
  // a shelf whose axis is locked behaves the same way (Left wall, X axis)
  const left = wall(nodes, 'left');
  const fl = resolveFacingFaces(panels, pick(shelf.id, 'front'), pick(left.id, 'front'));
  if (fl.ok) {
    const plan = planDimension(panels, fl.a, fl.b);
    assert(!plan.ok || plan.mode === 'box', 'locked-axis shelf: wall moves only as the fallback');
  }
});

section('the same pair can not be dimensioned twice', () => {
  const base = boxWithShelf();
  const { shelf, bottom, nodes } = base;
  const panels = base.panels.map((p) => (p.id === shelf.id ? { ...p, offset: { x: 0, y: 200, z: 0 } } : p));
  const first = addQuote(panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 150 });
  assert(first.ok, 'first dimension accepted');
  const again = addQuote(first.panels, { drivenId: shelf.id, myFace: 'front', from: front(bottom.id, 'back'), value: 90 });
  assert(!again.ok && again.reason === 'duplicate', 'the same quote again is refused (same direction)');
  assert(/already have a dimension/.test(again.message) && /Esc/.test(again.message), 'and the message says how to change or delete it');
  const swapped = addQuote(first.panels, { drivenId: bottom.id, myFace: 'back', from: front(shelf.id, 'front'), value: 150 });
  assert(!swapped.ok, 'the reverse direction (Bottom from the shelf) is refused too');
  const pick = (id, faceName) => ({ nodeId: id, faceName });
  const f = resolveFacingFaces(first.panels, pick(shelf.id, 'back'), pick(bottom.id, 'back'));
  const plan = planDimension(first.panels, f.a, f.b);
  assert(!plan.ok && plan.reason === 'duplicate', 'planDimension reports the duplicate (no wall is moved to work around it)');
});

report();

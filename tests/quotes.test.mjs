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
import { computeDimensionSpecs } from '../src/modeller/dimensions.js';
import { findQuoteConflicts } from '../src/engine/quoteConflicts.js';
import { validateDesign } from '../src/engine/validator.js';
import { detectJoints } from '../src/engine/joints.js';
import { previewQuote } from '../src/engine/quotes.js';
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

report();

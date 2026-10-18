import { ensureMaterialCatalog, section, assert, report } from './helpers.mjs';
import { addBox, relayoutBox } from '../src/features/box.js';
import { createPanelNode } from '../src/modeller/modules.js';
import { VERTICAL_ROTATION } from '../src/shared/geometry.js';
import { resolveConstraints } from '../src/modeller/snap.js';
import { planEqualSpacing, removeEqualSpacing } from '../src/engine/spacing.js';
await ensureMaterialCatalog();

section('equal spacing — 3 vertical shelves between Left and Right', () => {
  const { nodes } = addBox([]);
  const gid = nodes[0].groupId;
  const mk = (x, n) => ({ ...createPanelNode({ name: n, rotation: VERTICAL_ROTATION, width: 300, height: 600, basePosition: nodes[0].basePosition, offset: { x, y: 368, z: 0 } }), groupId: gid });
  const s = [mk(-120, 'S1'), mk(-20, 'S2'), mk(150, 'S3')];
  let panels = [...nodes, ...s];
  const L = nodes.find((p) => /^left/i.test(p.name));
  const R = nodes.find((p) => /^right/i.test(p.name));
  const r = planEqualSpacing(panels, s.map((x) => x.id), [L.id, R.id]);
  assert(r.ok, 'plan succeeds: ' + r.message);
  panels = r.panels;
  const gaps = (list) => {
    const res = resolveConstraints(list);
    const g = (id) => res.find((x) => x.id === id);
    const items = [L, ...s, R].map((p) => g(p.id)).sort((a, b) => a.position.x - b.position.x);
    return items.slice(1).map((it, i) => it.position.x - it.thickness / 2 - (items[i].position.x + items[i].thickness / 2));
  };
  const gp = gaps(panels);
  assert(gp.length === 4 && gp.every((x) => Math.abs(x - gp[0]) < 0.01), 'all 4 gaps are equal: ' + gp.map((x) => x.toFixed(2)).join(', '));

  // widen the box: the spacing follows live
  let wide = panels.map((p) => (p.id === R.id ? { ...p, offset: { ...p.offset, x: p.offset.x + 100 } } : p));
  const rl = relayoutBox(wide, gid);
  assert(rl.ok, 'box relayout ok');
  wide = wide.map((p) => { const q = rl.patches.find((x) => x.id === p.id); return q ? { ...p, ...q } : p; });
  const gw = gaps(wide);
  assert(gw.every((x) => Math.abs(x - gw[0]) < 0.01) && gw[0] > gp[0] + 15, 'after widening the gaps stay equal and grow');

  // remove: shelves keep their places
  const sid = panels.find((p) => p.id === s[0].id).constraints.find((c) => c.type === 'equalSpacing').spacingId;
  const rm = removeEqualSpacing(panels, sid);
  assert(rm.ok && rm.panels.every((p) => !(p.constraints || []).some((c) => c.type === 'equalSpacing')), 'spacing removed');
  const pos = (list) => resolveConstraints(list).filter((x) => s.some((q) => q.id === x.id)).map((x) => x.position.x.toFixed(2)).join();
  assert(pos(rm.panels) === pos(panels), 'shelves stay where they were');

  assert(!planEqualSpacing(panels, s.map((x) => x.id), [L.id, R.id]).ok, 'cannot space shelves that are already spaced');
  assert(!planEqualSpacing([...nodes, ...s], [s[0].id], [L.id, L.id]).ok, 'two identical boundaries are refused');
});
report();

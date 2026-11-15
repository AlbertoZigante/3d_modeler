/**
 * scripts/golden/builders.mjs
 *
 * Named, reproducible designs built with the REAL feature functions
 * (addBox / addShelf / door / drawer / plinth / leg) — same "empirical
 * ground truth" convention as tests/. Each builder returns RAW panels
 * (the graph, before resolveConstraints).
 *
 * IDs (panel-N) and piece codes come from module-level counters, so every
 * design MUST be built in its own fresh node process (see dump-golden.mjs).
 */
import { createPanelNode } from '../../src/modeller/modules.js';
import { addBox, relayoutBox } from '../../src/features/box.js';
import { addShelf } from '../../src/features/shelf.js';
import { computeBoundaryRectangle } from '../../src/shared/geometry.js';
import { computeDoorPlacement, createDoorNode, applyPanelPatch, DEFAULT_DOOR_EDGE_FIT } from '../../src/features/door.js';
import { computeDrawerFrontsPlacement, createDrawerFrontNodes, computeDrawerBoxPlacement, createDrawerBoxNodes, DEFAULT_DRAWER_EDGE_FIT } from '../../src/features/drawer.js';
import { addPlinthAndRaiseBox } from '../../src/features/plinth.js';
import { addLegsAndRaiseBox } from '../../src/features/leg.js';
import { addQuote } from '../../src/engine/quotes.js';
import { planEqualSpacing } from '../../src/engine/spacing.js';
import { LOCAL_FACES } from '../../src/modeller/modules.js';

const MAT = 'Melamine White 18mm';
const wall = (nodes, name) => nodes.find((n) => n.name === name);
const boundary = (nodes) => computeBoundaryRectangle(nodes, ['Left', 'Right', 'Top', 'Bottom'].map((n) => wall(nodes, n)));

function must(res, label) {
  if (!res.ok) throw new Error(`${label} failed: ${res.reason ?? JSON.stringify(res)}`);
  return res;
}

/** Raise/lower the Top wall by dyMm, then relayout the box (same path the UI uses). */
function resizeHeight(nodes, dyMm) {
  const top = wall(nodes, 'Top');
  const groupId = top.groupId;
  const moved = nodes.map((p) => (p.id === top.id ? { ...p, offset: { ...p.offset, y: p.offset.y + dyMm } } : p));
  const rl = must(relayoutBox(moved, groupId), 'relayoutBox');
  return moved.map((p) => {
    const patch = rl.patches.find((x) => x.id === p.id);
    return patch ? { ...p, width: patch.width, height: patch.height, offset: patch.offset } : p;
  });
}

function withDoor(nodes, hinge) {
  const placement = computeDoorPlacement(nodes, boundary(nodes), DEFAULT_DOOR_EDGE_FIT, { material: MAT, thicknessMm: 18, hinge });
  const door = createDoorNode(nodes, placement);
  let panels = [...nodes];
  placement.panelPatches.forEach((patch) => { panels = applyPanelPatch(panels, patch, placement.normalAxis); });
  return [...panels, door];
}

function withDrawers(nodes, count, withBoxes = true) {
  const placement = computeDrawerFrontsPlacement(nodes, boundary(nodes), DEFAULT_DRAWER_EDGE_FIT, { material: MAT, thicknessMm: 18, count });
  const fronts = createDrawerFrontNodes(nodes, placement, {});
  let panels = [...nodes, ...fronts];
  if (withBoxes) {
    fronts.forEach((front) => {
      const bp = computeDrawerBoxPlacement(panels, front, { material: MAT, thicknessMm: 18 });
      panels = [...panels, ...createDrawerBoxNodes(panels, bp)];
    });
  }
  return panels;
}

const box = () => addBox([]).nodes;
const gid = (nodes) => nodes[0].groupId;

export const DESIGNS = {
  // ---- carcass only
  box_plain: () => box(),
  box_shelf_h: () => {
    const b = box();
    return [...b, must(addShelf(b, wall(b, 'Left'), wall(b, 'Right'), { mode: 'horizontal', clickMm: null }), 'shelf').node];
  },
  box_shelf_v: () => {
    const b = box();
    return [...b, must(addShelf(b, wall(b, 'Bottom'), wall(b, 'Top'), { mode: 'vertical', clickMm: null }), 'shelf').node];
  },
  box_tall: () => resizeHeight(box(), 1100), // 1800 mm high

  // ---- features
  box_door_left: () => withDoor(box(), 'left'),
  box_door_right: () => withDoor(box(), 'right'),
  box_tall_door: () => withDoor(resizeHeight(box(), 1100), 'left'), // >1600 mm door -> 4 hinges
  box_drawer_1: () => withDrawers(box(), 1),
  box_drawers_3: () => withDrawers(box(), 3),
  box_drawer_fronts_only: () => withDrawers(box(), 2, false),
  box_plinth: () => { const b = box(); return must(addPlinthAndRaiseBox(b, gid(b), {}), 'plinth').panels; },
  box_legs: () => { const b = box(); return must(addLegsAndRaiseBox(b, gid(b)), 'legs').panels; },

  // ---- combinations (the assembly stage order: doors, drawers, guides, plinth, carcass)
  box_door_plinth: () => { const b = withDoor(box(), 'right'); return must(addPlinthAndRaiseBox(b, gid(b), {}), 'plinth').panels; },
  box_drawers_plinth: () => { const b = withDrawers(box(), 2); return must(addPlinthAndRaiseBox(b, gid(b), {}), 'plinth').panels; },
  box_shelf_door: () => {
    const b = box();
    const withShelf = [...b, must(addShelf(b, wall(b, 'Left'), wall(b, 'Right'), { mode: 'horizontal', clickMm: null }), 'shelf').node];
    return withDoor(withShelf, 'left');
  },

  // ---- multi-group + synthetic edge cases
  two_boxes: () => { const a = addBox([]).nodes; return [...a, ...addBox(a).nodes]; },
  empty: () => [],
  single_panel: () => [createPanelNode({ name: 'Floating', width: 100, height: 100, thickness: 18, rotation: { x: 0, y: 0, z: 0 } })],
  synthetic_overlap: () => {
    const a = createPanelNode({ name: 'A', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
    const b = createPanelNode({ name: 'B', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
    a.basePosition = { x: 0, y: 0, z: 0 };
    b.basePosition = { x: 0, y: 0, z: 5 };
    return [a, b];
  },
  synthetic_near_contact: () => {
    const a = createPanelNode({ name: 'A', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
    const b = createPanelNode({ name: 'B', width: 300, height: 300, thickness: 18, rotation: { x: 0, y: 0, z: 0 } });
    a.basePosition = { x: 0, y: 0, z: 0 };
    b.basePosition = { x: 0, y: 0, z: 19 }; // 1 mm gap (thickness 18)
    return [a, b];
  },
};

// ---------------------------------------------------------------------------
// RESOLVER fixtures — exercise every constraint type of snap.js resolveConstraints, its failure
// warnings, cycles, rotations and ordering. Only the `raw` and `resolved` stages are frozen for these
// (STAGE_SUBSET): several are deliberately broken graphs that later stages were never meant to digest.
// ---------------------------------------------------------------------------
const ROT0 = { x: 0, y: 0, z: 0 };
const node = (name, w, h, { rotation = ROT0, base = { x: 0, y: 0, z: 0 }, constraints = [], ...extra } = {}) => {
  const n = createPanelNode({ name, width: w, height: h, thickness: 18, rotation, constraints, ...extra });
  n.basePosition = { ...base };
  return n;
};
const end = (n, face, offset) => ({ node: n.id, face, ...(offset === undefined ? {} : { offset }) });
const spans = (field, from, to, extra = {}) => ({ id: `c-${field}-${from.face ?? 'mm'}`, type: 'spansBetween', field, overridden: false, from, to, ...extra });
const attached = (field, myFace, from, extra = {}) => ({ id: `a-${field}`, type: 'attachedTo', field, myFace, overridden: false, from, ...extra });
const quote = (field, myFace, from, value, extra = {}) => ({ id: `q-${field}`, type: 'distance', kind: 'quote', field, myFace, from, value, overridden: false, ...extra });

function firstValidQuote(panels, drivenId, anchorId, value) {
  for (const myFace of Object.keys(LOCAL_FACES)) {
    for (const face of Object.keys(LOCAL_FACES)) {
      const res = addQuote(panels, { drivenId, myFace, from: { node: anchorId, face }, value });
      if (res.ok) return res.panels;
    }
  }
  throw new Error('no valid quote found');
}

export const RESOLVE_DESIGNS = {
  resolve_attached_to: () => {
    const a = node('Wall', 1000, 600);
    const b = node('Shelf', 400, 300, { constraints: [
      attached('positionY', 'bottom', end(a, 'top', 50)),
      attached('positionX', 'left', end(a, 'right', -100)),
    ] });
    return [a, b];
  },
  resolve_distance_quote: () => {
    const a = node('Wall', 1000, 600);
    const c = node('Block', 400, 200, { constraints: [quote('positionX', 'left', end(a, 'right'), 25)] });
    const d = node('Block 2', 400, 200, { constraints: [quote('positionY', 'bottom', end(a, 'top'), 0)] });
    return [a, c, d];
  },
  resolve_quote_real: () => {
    const b = box();
    const shelf = must(addShelf(b, wall(b, 'Left'), wall(b, 'Right'), { mode: 'horizontal', clickMm: null }), 'shelf').node;
    const panels = [...b, shelf];
    return firstValidQuote(panels, shelf.id, wall(b, 'Bottom').id, 120);
  },
  resolve_equal_spacing: () => {
    let panels = box();
    const ids = [];
    for (const clickMm of [120, 240, 330]) {
      const res = must(addShelf(panels, wall(panels, 'Left'), wall(panels, 'Right'), { mode: 'horizontal', clickMm }), 'shelf');
      panels = [...panels, res.node];
      ids.push(res.node.id);
    }
    const planned = planEqualSpacing(panels, ids, [wall(panels, 'Bottom').id, wall(panels, 'Top').id]);
    if (!planned.ok) throw new Error(`planEqualSpacing: ${planned.message}`);
    return planned.panels;
  },
  resolve_equal_spacing_overflow: () => {
    // 3 members of 18 mm in a 30.5 mm gap: warning text uses Math.round(30.5) = 31 (JS rounds halves UP)
    const lo = node('Lo', 1000, 20);
    const hi = node('Hi', 1000, 20, { base: { x: 0, y: 50.5, z: 0 } });
    const mk = (name) => node(name, 400, 300);
    const ms = [mk('S1'), mk('S2'), mk('S3')];
    const members = [...ms.map((m) => m.id), 'panel-deleted'];
    ms.forEach((m, i) => m.constraints.push({ id: `e${i}`, type: 'equalSpacing', field: 'positionY', from: end(lo, 'top'), to: end(hi, 'bottom'), members, spacingId: 'sp1' }));
    return [lo, hi, ...ms];
  },
  resolve_literal_anchor: () => {
    const a = node('Wall', 1000, 600);
    const b = node('Resized', 100, 200, { constraints: [spans('width', { mm: 100 }, end(a, 'right', 0))] });
    return [a, b];
  },
  resolve_cycle: () => {
    const x = node('X', 300, 300);
    const y = node('Y', 300, 300);
    x.constraints.push(spans('width', end(y, 'left'), end(y, 'right')));
    y.constraints.push(spans('width', end(x, 'left'), end(x, 'right')));
    const z = node('Z', 300, 300);
    z.constraints.push(attached('positionX', 'left', end(z, 'right')));
    const w = node('W', 300, 300, { constraints: [spans('width', end(x, 'left'), end(x, 'right'))] });
    return [w, x, y, z];
  },
  resolve_errors: () => {
    const a = node('Ref', 1000, 600);
    const tilted = node('Tilted', 500, 500, { rotation: { x: 0, y: 0, z: 45 } });
    const out = [a, tilted];
    const add = (name, constraints, extra = {}) => { out.push(node(name, 300, 300, { constraints, ...extra })); };
    add('missing-ref', [spans('width', { node: 'panel-9999', face: 'right' }, end(a, 'right'))]);
    add('unknown-face', [spans('width', end(a, 'sideways'), end(a, 'right'))]);
    add('target-not-aligned', [spans('width', end(tilted, 'right'), end(a, 'right'))]);
    add('thickness-span', [spans('thickness', end(a, 'left'), end(a, 'right'))]);
    add('unknown-type', [{ id: 'u', type: 'frobnicate', field: 'width' }]);
    add('distance-negative', [quote('positionX', 'left', end(a, 'right'), -5)]);
    add('distance-not-facing', [quote('positionX', 'right', end(a, 'right'), 10)]);
    add('distance-no-myface', [{ id: 'd', type: 'distance', field: 'positionX', from: end(a, 'right'), value: 10, overridden: false }]);
    add('distance-on-size', [quote('width', 'left', end(a, 'right'), 10)]);
    add('distance-missing-anchor', [quote('positionX', 'left', { node: 'panel-9999', face: 'right' }, 10)]);
    add('attached-no-myface', [{ id: 'm', type: 'attachedTo', field: 'positionX', from: end(a, 'right'), overridden: false }]);
    add('attached-misaligned-own-face', [attached('positionX', 'right', end(a, 'right'))], { rotation: { x: 0, y: 0, z: 45 } });
    add('own-dimension-misaligned', [spans('width', end(a, 'left'), end(a, 'right'))], { rotation: { x: 0, y: 0, z: 45 } });
    add('overridden-is-ignored', [spans('width', end(a, 'left'), end(a, 'right'), { overridden: true })]);
    add('min-dimension-clamp', [spans('width', { mm: 100 }, { mm: 103 })]);
    add('not-in-own-set', [{ id: 'e', type: 'equalSpacing', field: 'positionY', from: end(a, 'bottom'), to: end(a, 'top'), members: ['panel-1'], spacingId: 'spX' }]);
    add('span-on-position-field', [spans('positionX', end(a, 'left'), end(a, 'right'))]);
    add('two-bad-constraints', [spans('width', end(a, 'sideways'), end(a, 'right')), attached('positionY', 'top', { node: 'panel-9999', face: 'top' })]);
    return out;
  },
  resolve_rotated: () => {
    const a = node('Ref', 1000, 600);
    const out = [a];
    const rots = [
      { x: 0, y: 90, z: 0 }, { x: 90, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, { x: 90, y: 90, z: 0 },
      { x: 0, y: -90, z: 0 }, { x: 0, y: 180, z: 0 }, { x: 180, y: 0, z: 0 }, { x: 0, y: 0, z: 11 }, { x: 0, y: 0, z: 12 },
      // all three angles non-zero: every term of the Euler matrix matters
      { x: 90, y: 90, z: 90 }, { x: 30, y: 60, z: 45 }, { x: 180, y: 90, z: 180 },
    ];
    rots.forEach((rotation, i) => {
      out.push(node(`R${i}`, 300, 200, { rotation, constraints: [
        spans('width', end(a, 'left'), end(a, 'right')),
        spans('height', end(a, 'bottom'), end(a, 'top')),
        attached('positionZ', 'front', end(a, 'back', 10)),
      ] }));
    });
    return out;
  },
  resolve_locked_axes: () => {
    const a = node('Wall', 1000, 600, { groupId: 'g-1', hidden: true });
    const b = node('Locked', 300, 300, { lockedMoveAxes: ['x', 'z', 'nonsense'], base: { x: 5, y: 6, z: 7 } });
    b.offset = { x: 1, y: 2, z: 3 };
    return [a, b];
  },
  resolve_constraint_order: () => {
    // attachedTo is listed BEFORE the spansBetween it depends on (the resolver must still run spans first)
    const a = node('Wall', 1000, 600);
    const b = node('Order', 100, 100, { constraints: [] });
    b.constraints.push(attached('positionX', 'left', end(a, 'left', 0)));
    b.constraints.push(spans('width', end(a, 'left', 0), end(a, 'right', 0), { id: 'late-span' }));
    return [a, b];
  },
  resolve_chain_reverse: () => {
    // each panel's width is spanned by the next one's faces; declared in REVERSE dependency order
    const n = [0, 1, 2, 3, 4].map((i) => node(`N${i}`, 200 + 10 * i, 100));
    for (let i = 1; i < n.length; i++) n[i].constraints.push(spans('width', end(n[i - 1], 'left'), end(n[i - 1], 'right', 20 * i)));
    return [...n].reverse();
  },
};
Object.assign(DESIGNS, RESOLVE_DESIGNS);

// ---------------------------------------------------------------------------
// JOINT fixtures — engine/joints.js detectJoints + detectFeatureJoints on hand-placed panels, aimed at every
// threshold and branch (contact epsilon, near-contact tolerance, minimum contact length, collision depth,
// corner vs T, edge-to-edge, hinge/slide guards). Frozen stages: raw, resolved, joints, featureJoints.
// ---------------------------------------------------------------------------
const Y90 = { x: 0, y: 90, z: 0 }; // thickness along X, width along Z, height along Y
const at = (n, x, y, z) => { n.basePosition = { x, y, z }; return n; };

export const JOINT_DESIGNS = {
  joints_corner_vs_t: () => {
    const wall = node('Wall', 800, 600); // thickness Z: its broad face is the contact plane
    const mk = (name, h, x, y) => at(node(name, 300, h, { rotation: Y90 }), x, y, 9 + 150); // sits on the wall's front face
    return [wall,
      mk('Corner', 600, -400 + 9, 0),   // flush with the wall's left edge, full height     -> corner_butt
      mk('MidT', 600, 0, 0),             // mid-span in X, full height                       -> t_butt
      mk('MidT partial', 200, 200, -100), // mid-span in X and a partial slice in Y           -> t_butt
      mk('Edge partial', 200, 391, 100), // touches the right edge but only part of Y        -> corner_butt
      // BACK face of the wall: edge offsets just either side of the 0.5 mm boundary tolerance
      at(node('Left edge +0.55', 300, 200, { rotation: Y90 }), -400 + 0.55 + 9, 0, -(9 + 150)), // 0.55 > 0.5 from the edge -> t_butt
      at(node('Right edge -0.45', 300, 200, { rotation: Y90 }), 400 - 0.45 - 9, 0, -(9 + 150)), // 0.45 <= 0.5              -> corner_butt
      // footprints coincide exactly on both axes: no mid-span evidence, defaults to corner_butt
      at(node('Narrow flat', 18, 100), 2000, 0, 0),
      at(node('Narrow butt', 100, 100, { rotation: Y90 }), 2000, 0, 9 + 50)];
  },
  joints_thresholds: () => {
    const out = [];
    // 5 columns x 3 rows, 1000 mm apart: far enough that cases never touch each other, and inside the API's
    // coordinate bounds (|x| <= 10000).
    const column = (i, name, gapZ, partnerExtra = {}) => {
      const x = (i % 5) * 1000;
      const y = Math.floor(i / 5) * 1000;
      out.push(at(node(`${name} base`, 400, 400), x, y, 0));
      out.push(at(node(`${name} partner`, 400, 400, partnerExtra.node ?? {}), x + (partnerExtra.dx ?? 0), y, 18 + gapZ));
    };
    // gap along Z between the two broad faces (negative = overlap)
    [-0.049, -0.051, 0, 0.049, 0.051, 2.9, 3.0, 3.1, -0.99, -1.0, -1.01, -5].forEach((g, i) => column(i, `gap ${g}`, g));
    // footprint overlap on X (partner shifted so only `o` mm overlap): 4.9 / 5.0 / 5.1 mm
    [4.9, 5.0, 5.1].forEach((o, k) => column(12 + k, `footprint ${o}`, 0, { dx: 400 - o }));
    return out;
  },
  joints_edge_to_edge: () => [
    at(node('E1', 400, 400, { rotation: Y90 }), 0, 0, 0),
    at(node('E2', 400, 400, { rotation: Y90 }), 0, 0, 400),     // edge meets edge along Z -> edge_to_edge (unhandled)
    at(node('E3', 400, 400, { rotation: Y90 }), 0, 0, 800.04),  // 0.04 mm gap along Z       -> still touching
    at(node('Hidden', 400, 400, { rotation: Y90, hidden: true }), 0, 0, 1200), // hidden panels never joint
    at(node('G1', 400, 400, { groupId: 'g' }), 5000, 0, 0),
    at(node('G2', 400, 400, { groupId: 'g' }), 5000, 0, 18),    // same group
    at(node('G3', 400, 400, { groupId: 'h' }), 5000, 0, 36),    // different group
  ],
  joints_features_synthetic: () => {
    const out = [];
    const L = at(node('Left side', 600, 700, { rotation: Y90 }), -300, 350, 0);
    const R = at(node('Right side', 600, 700, { rotation: Y90 }), 300, 350, 0);
    out.push(L, R);
    const door = (name, hinge, normalAxis, bids, rotation = ROT0, base = { x: 0, y: 350, z: 309 }, w = 580) =>
      at(node(name, w, 690, { rotation, isDoor: true, hinge, normalAxis, boundaryIds: bids }), base.x, base.y, base.z);
    out.push(door('door-left', 'left', 'z', { left: L.id, right: R.id }));
    out.push(door('door-right', 'right', 'z', { left: L.id, right: R.id }));
    out.push(door('door-x-axis', 'right', 'x', { left: L.id, right: R.id }, Y90, { x: 309, y: 350, z: 0 }));
    out.push(door('door-lid-y', 'left', 'y', { left: L.id, right: R.id }));            // normalAxis y: skipped
    out.push(door('door-no-hinge', undefined, 'z', { left: L.id, right: R.id }));        // skipped
    out.push(door('door-ghost-panel', 'left', 'z', { left: 'ghost', right: R.id }));     // boundary does not exist: skipped
    out.push(door('door-missing-side', 'right', 'z', { left: L.id }));                    // no id for that side: skipped
    out.push(door('door-empty-boundaries', 'left', 'z', {}));                             // {} is truthy in JS: reaches the id check, skipped
    const front = at(node('front', 580, 200, { isDrawerFront: true, normalAxis: 'z', boundaryIds: { left: L.id, right: R.id } }), 0, 100, 309);
    const side = (name, role, x, extra = {}) => at(node(name, 500, 150, { rotation: Y90, isDrawerBoxPanel: true, drawerBoxFrontId: front.id, drawerBoxRole: role, ...extra }), x, 100, 50);
    out.push(front, side('box-left', 'left', -270), side('box-right', 'right', 272.5));
    const front2 = at(node('front2', 580, 200, { isDrawerFront: true, normalAxis: 'z', boundaryIds: { left: L.id, right: 'ghost' } }), 0, -150, 309);
    out.push(front2, side('box2-left', 'left', -270, { drawerBoxFrontId: front2.id }));  // right side: boundary missing
    const front3 = at(node('front3', 580, 200, { isDrawerFront: true, normalAxis: 'z', boundaryIds: { left: L.id, right: R.id } }), 0, -400, 309);
    out.push(front3, side('box3-wrong-role', 'left', -270, { drawerBoxFrontId: front3.id, drawerBoxRole: 'bottom' })); // no side panel
    return out;
  },
};
Object.assign(DESIGNS, JOINT_DESIGNS);

/** Designs that freeze only some stages (the rest are not meaningful for deliberately odd graphs). */
export const STAGE_SUBSET = {
  ...Object.fromEntries(Object.keys(RESOLVE_DESIGNS).map((n) => [n, ['raw', 'resolved']])),
  ...Object.fromEntries(Object.keys(JOINT_DESIGNS).map((n) => [n, ['raw', 'resolved', 'joints', 'featureJoints']])),
};

export const DESIGN_NAMES = Object.keys(DESIGNS);

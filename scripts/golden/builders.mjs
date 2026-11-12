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

export const DESIGN_NAMES = Object.keys(DESIGNS);

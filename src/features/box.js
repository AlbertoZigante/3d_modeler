/**
 * features/box.js
 *
 * Everything that defines what a BOX is: creation and the carcass
 * layout math. PURE MODULE — nothing here touches the global `panels`
 * array or calls history/render; every function takes the data it
 * needs as arguments and returns data. modeller-main.js remains the
 * single writer — it applies whatever this module returns.
 *
 * Box wall convention (verified against the real construction, not
 * inferred): Left/Right run full height+depth; Top/Bottom run the
 * full outer width; Back covers the whole outer footprint
 * (W × H+2T — like a real cabinet's back sheet nailed across the
 * carcass, not let into it); Front is inset only in width (W-2T × H)
 * and created hidden — "open-front box" means the panel exists,
 * restorable via the group inspector, not that it's absent.
 *
 * STAGE 3: box walls carry NO spansBetween/attachedTo constraints —
 * a fully cross-referential 6-panel box is impossible through
 * resolveConstraints' per-node cycle check ("Left depends on Top for
 * height; Top depends on Left for width" gets flagged circular even
 * though the two fields don't conflict — tested, real dead end). Box
 * internals are plain arithmetic instead: computeBoxLayout() below,
 * which addBox() and relayoutBox() both funnel through.
 */
import { createPanelNode, computeNextBasePosition, MATERIAL_CATALOG, MIN_PANEL_DIM_MM } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';
import {
  VERTICAL_ROTATION,
  HORIZONTAL_ROTATION,
  PARALLEL_ROTATION,
  collectAxisSlabs,
  checkMinGap,
  findPanelSizeViolation,
  findDesignLimitViolation,
} from '../shared/geometry.js';

export const DEFAULT_BOX_WIDTH_MM = 500;
export const DEFAULT_BOX_HEIGHT_MM = 700;
export const DEFAULT_BOX_DEPTH_MM = 400;

const BOX_GIZMO_LOCKS = {
  leftRight: {
    lockedMoveAxes: ['y', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: { positionY: true, positionZ: true },
  },
  topBottom: {
    lockedMoveAxes: ['x', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: { positionX: true, positionZ: true },
  },
  frontBack: {
    lockedMoveAxes: ['x', 'y'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: { positionX: true, positionY: true },
  },
};

/**
 * Pure carcass math: given the box's 6 wall nodes (each just needs
 * .thickness and .offset), returns each wall's new width/height/
 * offset so the assembly stays airtight no matter which wall(s) were
 * dragged. Only left.offset.x / right.offset.x / top.offset.y /
 * bottom.offset.y / back.offset.z / front.offset.z are ever treated
 * as "driving" values — everything else here is derived. All
 * measurements are in OFFSET space (relative to the box's shared
 * basePosition anchor) — it cancels out of every difference used
 * here, so the anchor itself is never read.
 */
export function computeBoxLayout({ left, right, top, bottom, back, front }) {
  const lx = left.offset.x, rx = right.offset.x;
  const ty = top.offset.y, by = bottom.offset.y;
  const bz = back.offset.z, fz = front.offset.z;

  const xOuterMin = lx - left.thickness / 2, xOuterMax = rx + right.thickness / 2;
  const xInnerMin = lx + left.thickness / 2, xInnerMax = rx - right.thickness / 2;
  const yOuterMin = by - bottom.thickness / 2, yOuterMax = ty + top.thickness / 2;
  const yInnerMin = by + bottom.thickness / 2, yInnerMax = ty - top.thickness / 2;
  const zInnerMin = bz - back.thickness / 2, zInnerMax = fz + front.thickness / 2;

  const outerWidth = xOuterMax - xOuterMin;
  const innerWidth = xInnerMax - xInnerMin;
  const innerHeight = yInnerMax - yInnerMin;
  const innerDepth = zInnerMax - zInnerMin;

  const outerWidthCenterX = (xOuterMin + xOuterMax) / 2;
  const innerWidthCenterX = (xInnerMin + xInnerMax) / 2;
  const outerHeightCenterY = (yOuterMin + yOuterMax) / 2;
  const innerHeightCenterY = (yInnerMin + yInnerMax) / 2;
  const innerDepthCenterZ = (zInnerMin + zInnerMax) / 2;

  return {
    left:   { width: innerDepth, height: innerHeight, offset: { x: lx, y: innerHeightCenterY, z: innerDepthCenterZ } },
    right:  { width: innerDepth, height: innerHeight, offset: { x: rx, y: innerHeightCenterY, z: innerDepthCenterZ } },
    top:    { width: outerWidth, height: innerDepth,  offset: { x: outerWidthCenterX, y: ty, z: innerDepthCenterZ } },
    bottom: { width: outerWidth, height: innerDepth,  offset: { x: outerWidthCenterX, y: by, z: innerDepthCenterZ } },
    back:   { width: innerWidth, height: innerHeight, offset: { x: innerWidthCenterX, y: outerHeightCenterY, z: bz } },
    front:  { width: innerWidth, height: innerHeight, offset: { x: innerWidthCenterX, y: innerHeightCenterY, z: fz } },
  };
}

/**
 * Creates a new box: 6 panel nodes, grouped, with Front hidden by
 * default. Needs `panels` (read-only) to place the new box's anchor
 * where computeNextBasePosition finds room, without overlapping
 * anything already on the floor — this is the one place addBox()
 * isn't fully closure-free, but it never mutates `panels`.
 *
 * Returns { nodes, groupId }; caller (modeller-main.js's
 * handleAddBox()) is responsible for committing.
 */
export function addBox(panels) {
  const W = DEFAULT_BOX_WIDTH_MM;
  const H = DEFAULT_BOX_HEIGHT_MM;
  const D = DEFAULT_BOX_DEPTH_MM;
  const material = MATERIAL_CATALOG[0].name;
  const T = MATERIAL_CATALOG[0].thicknessMm;

  const left = createPanelNode({
    name: 'Left', width: D, height: H, thickness: T, material,
    rotation: VERTICAL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.leftRight.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.leftRight.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.leftRight.lockedFields },
  });
  const right = createPanelNode({
    name: 'Right', width: D, height: H, thickness: T, material,
    rotation: VERTICAL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.leftRight.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.leftRight.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.leftRight.lockedFields },
  });
  const top = createPanelNode({
    name: 'Top', width: W, height: D, thickness: T, material,
    rotation: HORIZONTAL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.topBottom.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.topBottom.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.topBottom.lockedFields },
  });
  const bottom = createPanelNode({
    name: 'Bottom', width: W, height: D, thickness: T, material,
    rotation: HORIZONTAL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.topBottom.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.topBottom.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.topBottom.lockedFields },
  });
  const back = createPanelNode({
    name: 'Back',
    // Covers all 4 outer edges of the assembly (H+2T) — like a real
    // cabinet's solid back sheet, nailed across the whole carcass
    // rather than let into it. Just a starting value — relayoutBox
    // (via computeBoxLayout below) recomputes it exactly.
    width: W, height: H + 2 * T, thickness: T, material,
    rotation: PARALLEL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.frontBack.lockedFields },
  });
  const front = createPanelNode({
    name: 'Front',
    // Inner-fitted footprint — inset between the sides only, W-2T.
    width: W - 2 * T, height: H, thickness: T, material,
    rotation: PARALLEL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.frontBack.lockedFields },
  });

  const boxPanels = [left, right, top, bottom, back, front];
  boxPanels.forEach((p) => { p.groupId = left.id; }); // left's own id doubles as the group's identifier

  // All 6 box panels share ONE basePosition — the box's own single
  // placement slot (treating its WxH front footprint like one panel
  // for that purpose) — rather than each independently claiming its
  // own row slot the way plain "add panel" does. computeBoxLayout()
  // (and later relayoutBox()) works entirely in offset-space relative
  // to this shared anchor, so the anchor itself is never touched
  // again after this.
  const anchor = computeNextBasePosition(resolveConstraints(panels), { width: W, height: H, thickness: T, rotation: PARALLEL_ROTATION });
  anchor.y = H / 2 + T; // sits on the floor
  boxPanels.forEach((p) => { p.basePosition = anchor; });

  // Starting offsets — each wall's own driving axis. Every other
  // offset/dimension field gets overwritten by computeBoxLayout below
  // regardless of what's set here.
  left.offset = { x: -(W / 2 - T / 2), y: 0, z: 0 };
  right.offset = { x: +(W / 2 - T / 2), y: 0, z: 0 };
  bottom.offset = { x: 0, y: -H / 2 - T / 2, z: 0 };
  top.offset = { x: 0, y: +H / 2 + T / 2, z: 0 };
  back.offset = { x: 0, y: 0, z: -D / 2 - T / 2 };
  front.offset = { x: 0, y: 0, z: +D / 2 + T / 2 };

  // Run the SAME layout math relayoutBox() will use on every later
  // edit, directly against these local node references — no need to
  // round-trip through the graph via findBoxSibling since we already
  // hold every node. This makes a fresh box indistinguishable from
  // "just been dragged into this shape".
  const layout = computeBoxLayout({ left, right, top, bottom, back, front });
  for (const [role, node] of Object.entries({ left, right, top, bottom, back, front })) {
    node.width = layout[role].width;
    node.height = layout[role].height;
    node.offset = layout[role].offset;
  }

  front.hidden = true; // "open-front box" — a real, restorable panel, just not shown

  return { nodes: boxPanels, groupId: left.id };
}

/** Find a specific wall of a box by its role name ('Back', 'Front', etc). */
export function findBoxSibling(panels, groupId, name) {
  return panels.find((p) => p.groupId === groupId && p.name === name) || null;
}

/**
 * Recomputes every wall of a box after one wall's free-axis offset
 * has already changed in `panels` (relayoutBox doesn't decide which
 * wall moved or by how much — it derives the box's current layout
 * from whatever offsets are already on the 6 walls, then recomputes
 * every wall to match).
 *
 * Pure: returns either
 *   { ok: true, patches: [{ id, width, height, offset }, ...] }
 * or
 *   { ok: false, hitAxis }
 *   { ok: false, reason: 'min-dim' | 'panel-size:<field>' | 'min-gap:<a>/<b>' }
 * and mutates nothing — modeller-main.js's applyRelayoutResult()
 * applies the patches (or shows the matching toast) and owns
 * history/render, per the single-writer rule.
 */
export function relayoutBox(panels, groupId) {
  const roles = {
    left: findBoxSibling(panels, groupId, 'Left'), right: findBoxSibling(panels, groupId, 'Right'),
    top: findBoxSibling(panels, groupId, 'Top'), bottom: findBoxSibling(panels, groupId, 'Bottom'),
    back: findBoxSibling(panels, groupId, 'Back'), front: findBoxSibling(panels, groupId, 'Front'),
  };
  if (Object.values(roles).some((n) => !n)) return { ok: true, patches: [] }; // defensive no-op — a box mid-construction/deletion has nothing to relayout yet

  const layout = computeBoxLayout(roles);

  for (const [role, node] of Object.entries(roles)) {
    const dims = { width: layout[role].width, height: layout[role].height, thickness: node.thickness };
    if (dims.width < MIN_PANEL_DIM_MM || dims.height < MIN_PANEL_DIM_MM) {
      return { ok: false, reason: 'min-dim' };
    }
    const sizeViolation = findPanelSizeViolation(dims);
    if (sizeViolation) return { ok: false, reason: `panel-size:${sizeViolation}` };
    const positionMm = {
      x: node.basePosition.x + layout[role].offset.x,
      y: node.basePosition.y + layout[role].offset.y,
      z: node.basePosition.z + layout[role].offset.z,
    };
    const hitAxis = findDesignLimitViolation(node.rotation, positionMm, dims);
    if (hitAxis) return { ok: false, hitAxis };
  }

  const yCheck = checkMinGap(collectAxisSlabs(panels, groupId, 'y', {
    [roles.bottom.id]: { center: layout.bottom.offset.y, halfThickness: roles.bottom.thickness / 2, label: 'Bottom' },
    [roles.top.id]:    { center: layout.top.offset.y,    halfThickness: roles.top.thickness / 2,    label: 'Top' },
  }));
  if (!yCheck.ok) return { ok: false, reason: `min-gap:${yCheck.a}/${yCheck.b}` };

  const xCheck = checkMinGap(collectAxisSlabs(panels, groupId, 'x', {
    [roles.left.id]:  { center: layout.left.offset.x,  halfThickness: roles.left.thickness / 2,  label: 'Left' },
    [roles.right.id]: { center: layout.right.offset.x, halfThickness: roles.right.thickness / 2, label: 'Right' },
  }));
  if (!xCheck.ok) return { ok: false, reason: `min-gap:${xCheck.a}/${xCheck.b}` };

  const patches = Object.entries(roles).map(([role, node]) => ({
    id: node.id,
    width: layout[role].width,
    height: layout[role].height,
    offset: layout[role].offset,
  }));
  return { ok: true, patches };
}

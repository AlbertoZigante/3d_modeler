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
 * inferred): Top/Bottom always run the full outer width. Left/Right/
 * Top/Bottom's own DEPTH extent (Z axis), and Back/Front's own WIDTH/
 * HEIGHT footprint (X/Y), are both driven by Back's and Front's
 * per-edge `edgeFit` (see DEFAULT_EDGE_FIT below) — by default, Back
 * covers the whole outer footprint (edgeFit 'out' on all 4 edges,
 * like a real cabinet's back sheet nailed across the carcass) while
 * Front covers every edge except the top (edgeFit 'out' on
 * left/right/bottom, 'in' on top — Left/Right/Bottom get shortened at
 * the front end to make room for it, Top runs its full depth flush to
 * Front's face). Front is also created hidden — "open-front box"
 * means the panel exists, restorable via the group inspector, not
 * that it's absent.
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

// A Front or Back wall's own 4 in-plane edges (left/right against
// Left/Right, bottom/top against Top/Bottom) can each independently
// sit flush INSIDE the adjoining wall ('in') or flush OUTSIDE,
// covering that wall's edge ('out'). This is the SAME edgeFit value
// that also governs the adjoining wall's own DEPTH extent (see
// depthRangeFor below) — an 'out' edge means this Back/Front panel
// now covers that wall's end in Z too, so the wall must be shortened
// by this panel's own thickness there to avoid interpenetrating it;
// 'in' means the wall stays flush with this panel's outer face
// (unshortened). Either way the box's own overall footprint — driven
// solely by Left/Right/Top/Bottom's offsets and Back's/Front's own Z
// offsets — never changes; edgeFit only ever redistributes exactly
// how much of that fixed footprint the wall it's set on, and the
// wall(s) touching each of its edges, actually occupy. Lives directly
// on the node (like `hidden`/`isBoxWall`) — box internals are plain
// arithmetic (see this file's own doc comment above), not the
// spansBetween constraint graph, so there's nothing to wire into
// resolveConstraints for this.
export const DEFAULT_EDGE_FIT = { left: 'in', right: 'in', bottom: 'in', top: 'in' };

// addBox()'s actual starting values (see this file's top doc comment
// for why) — kept distinct from DEFAULT_EDGE_FIT above, which stays
// the internal fallback for missing/legacy data so pre-existing boxes
// keep rendering exactly as they always did.
const BACK_START_EDGE_FIT = { left: 'out', right: 'out', bottom: 'out', top: 'out' };
const FRONT_START_EDGE_FIT = { left: 'out', right: 'out', bottom: 'out', top: 'in' };

// Resolves a Front/Back wall's actual width/height/offset from its
// own edgeFit (defaulting missing/undefined to DEFAULT_EDGE_FIT,
// which reproduces the exact original hardcoded inner/inner/inner/
// inner numbers 1:1 — a node with no edgeFit field at all renders
// identically to before this feature existed). `bounds` are the box's
// already-computed inner/outer extents on X and Y — see
// computeBoxLayout below, the only caller.
function resolvePanelFit(edgeFit, bounds) {
  const fit = { ...DEFAULT_EDGE_FIT, ...(edgeFit || {}) };
  const xMin = fit.left === 'out' ? bounds.xOuterMin : bounds.xInnerMin;
  const xMax = fit.right === 'out' ? bounds.xOuterMax : bounds.xInnerMax;
  const yMin = fit.bottom === 'out' ? bounds.yOuterMin : bounds.yInnerMin;
  const yMax = fit.top === 'out' ? bounds.yOuterMax : bounds.yInnerMax;
  return {
    width: xMax - xMin,
    height: yMax - yMin,
    offsetX: (xMin + xMax) / 2,
    offsetY: (yMin + yMax) / 2,
  };
}

// The flip side of resolvePanelFit above: for ONE of Left/Right/Top/
// Bottom (`role` is 'left'/'right'/'top'/'bottom' — the exact same
// key Back's and Front's own edgeFit objects use for "the edge facing
// this wall"), works out where that wall's two Z-ends actually land.
// `zBackOuter`/`zFrontOuter` are Back's/Front's own outer faces — the
// box's true, fixed front/back boundary, never touched by anyone's
// edgeFit. Each end independently pulls in by that panel's own
// thickness when its edgeFit for this role is 'out' (that panel now
// covers this wall's end — the wall must be shorter there so the two
// don't interpenetrate), or stays flush with that panel's outer face
// when 'in' (today's original, unshortened behavior). Because both
// ends are resolved independently, a wall can be shortened at one end
// only, both ends, or neither — whatever the current Back/Front
// edgeFit says — and re-flipping either one later (e.g. Front's
// `left` edge going 'out' back to 'in') recovers the exact original
// length automatically, since nothing here is additive/stateful, it's
// recomputed from scratch every time.
function depthRangeFor(role, zBackOuter, zFrontOuter, back, front) {
  const backEdge = (back.edgeFit || DEFAULT_EDGE_FIT)[role] ?? DEFAULT_EDGE_FIT[role];
  const frontEdge = (front.edgeFit || DEFAULT_EDGE_FIT)[role] ?? DEFAULT_EDGE_FIT[role];
  const zMin = backEdge === 'out' ? zBackOuter + back.thickness : zBackOuter;
  const zMax = frontEdge === 'out' ? zFrontOuter - front.thickness : zFrontOuter;
  return { depth: zMax - zMin, centerZ: (zMin + zMax) / 2 };
}

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

  const outerWidth = xOuterMax - xOuterMin;
  const outerWidthCenterX = (xOuterMin + xOuterMax) / 2;

  const bounds = { xOuterMin, xOuterMax, xInnerMin, xInnerMax, yOuterMin, yOuterMax, yInnerMin, yInnerMax };
  const frontFit = resolvePanelFit(front.edgeFit, bounds);
  const backFit = resolvePanelFit(back.edgeFit, bounds);
  const innerHeight = bounds.yInnerMax - bounds.yInnerMin; // Left/Right's own height still always spans fully inset, regardless of Front/Back's edgeFit

  // Back's/Front's own outer Z faces — the box's true front/back
  // boundary. NEVER touched by anyone's edgeFit — this, together with
  // Left/Right/Top/Bottom's own X/Y offsets, is what keeps the box's
  // overall size fixed no matter how any wall's edgeFit is set.
  const zBackOuter = bz - back.thickness / 2;
  const zFrontOuter = fz + front.thickness / 2;

  const leftDepth = depthRangeFor('left', zBackOuter, zFrontOuter, back, front);
  const rightDepth = depthRangeFor('right', zBackOuter, zFrontOuter, back, front);
  const topDepth = depthRangeFor('top', zBackOuter, zFrontOuter, back, front);
  const bottomDepth = depthRangeFor('bottom', zBackOuter, zFrontOuter, back, front);

  return {
    left:   { width: leftDepth.depth,   height: innerHeight, offset: { x: lx, y: (bounds.yInnerMin + bounds.yInnerMax) / 2, z: leftDepth.centerZ } },
    right:  { width: rightDepth.depth,  height: innerHeight, offset: { x: rx, y: (bounds.yInnerMin + bounds.yInnerMax) / 2, z: rightDepth.centerZ } },
    top:    { width: outerWidth, height: topDepth.depth,    offset: { x: outerWidthCenterX, y: ty, z: topDepth.centerZ } },
    bottom: { width: outerWidth, height: bottomDepth.depth, offset: { x: outerWidthCenterX, y: by, z: bottomDepth.centerZ } },
    back:   { width: backFit.width,  height: backFit.height,  offset: { x: backFit.offsetX,  y: backFit.offsetY,  z: bz } },
    front:  { width: frontFit.width, height: frontFit.height, offset: { x: frontFit.offsetX, y: frontFit.offsetY, z: fz } },
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
    // Starting numbers only — relayoutBox (via computeBoxLayout below)
    // recomputes this exactly from back.edgeFit, set right after.
    width: W, height: H + 2 * T, thickness: T, material,
    rotation: PARALLEL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.frontBack.lockedFields },
  });
  back.edgeFit = { ...BACK_START_EDGE_FIT }; // covers the full outer footprint — see this file's top doc comment
  const front = createPanelNode({
    name: 'Front',
    // Starting numbers only — relayoutBox (via computeBoxLayout below)
    // recomputes this exactly from front.edgeFit, set right after.
    width: W - 2 * T, height: H, thickness: T, material,
    rotation: PARALLEL_ROTATION, isBoxPanel: true, isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.frontBack.lockedFields },
  });
  front.edgeFit = { ...FRONT_START_EDGE_FIT }; // covers every edge but the top — see this file's top doc comment

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

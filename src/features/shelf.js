/**
 * features/shelf.js
 *
 * SHELF feature — pure creation math. Reuses the exact same live-
 * constraint approach as box walls: a shelf's width/height are
 * spansBetween constraints against whichever two boundary panels
 * were picked (plus the box's own Back/Front for depth), so if
 * either boundary is later resized or moved, this shelf's dimensions
 * re-resolve right along with it. No cycle risk: a shelf only ever
 * depends on panels that existed before it.
 *
 * PURE — addShelf() never touches history, selection, or rendering.
 * See tools/shelfTool.js (the only caller) for the commit path and
 * the pick-mode interaction that supplies pick1/pick2/mode/clickMm.
 */
import { createPanelNode, nextConstraintId } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';
import { findBoxSibling, DEFAULT_BOX_DEPTH_MM } from './box.js';
import { collectAxisSlabs, VERTICAL_ROTATION, HORIZONTAL_ROTATION, rotationsMatch, MIN_WALL_GAP_MM, facingFace } from '../shared/geometry.js';

/**
 * @param {Array} panels - current graph
 * @param {Object} pick1 - first boundary panel node (a box wall or an existing shelf of the matching rotation)
 * @param {Object} pick2 - second boundary panel node, same box as pick1
 * @param {{ mode: 'horizontal'|'vertical', clickMm: number|null }} options
 *   clickMm is the desired position along the shelf's free axis, from
 *   where the first pick was clicked — null if unavailable (e.g. 2D
 *   view), in which case this falls back to auto-placement in the
 *   largest available gap.
 * @returns {{ ok: true, node: Object, groupId: string }
 *         | { ok: false, reason: 'no-space-at-click' | 'no-space' | 'invalid' }}
 */
export function addShelf(panels, pick1, pick2, { mode, clickMm }) {
  const groupId = pick1.groupId;
  const back = findBoxSibling(panels, groupId, 'Back');
  const front = findBoxSibling(panels, groupId, 'Front');
  if (!back || !front) return { ok: false, reason: 'invalid' };

  const resolved = resolveConstraints(panels);
  const r1 = resolved.find((r) => r.id === pick1.id);
  const r2 = resolved.find((r) => r.id === pick2.id);
  if (!r1 || !r2) return { ok: false, reason: 'invalid' };

  const spanAxis = mode === 'horizontal' ? 'x' : 'y';
  const face1 = facingFace(r1, spanAxis, r2);
  const face2 = facingFace(r2, spanAxis, r1);
  if (!face1 || !face2) return { ok: false, reason: 'invalid' };

  const freeAxis = mode === 'horizontal' ? 'y' : 'x';
  const anchor = pick1.basePosition;
  const thickness = pick1.thickness;
  const existingSlabs = collectAxisSlabs(panels, groupId, freeAxis).sort((a, b) => a.center - b.center);

  let proposedFreeOffset;
  if (clickMm != null) {
    const picked = pickGapForPosition(existingSlabs, clickMm, thickness);
    if (!picked.fits) return { ok: false, reason: 'no-space-at-click' };
    proposedFreeOffset = picked.center;
  } else {
    const slot = findBestShelfSlot(existingSlabs, thickness);
    const requiredSpan = thickness + 2 * MIN_WALL_GAP_MM;
    if (!slot || slot.clearSpan < requiredSpan) return { ok: false, reason: 'no-space' };
    proposedFreeOffset = slot.center;
  }

  const spanFieldForBoundary = mode === 'horizontal' ? 'width' : 'height';
  const startWidthOrHeight = Math.abs(r2.position[spanAxis] - r1.position[spanAxis]);
  const rotation = mode === 'horizontal' ? HORIZONTAL_ROTATION : VERTICAL_ROTATION;
  const material = pick1.material;

  const spanToBoundaries = {
    field: spanFieldForBoundary, type: 'spansBetween', overridden: false,
    from: { node: pick1.id, face: face1, offset: 0 },
    to: { node: pick2.id, face: face2, offset: 0 },
    id: nextConstraintId(),
  };
  const spanToDepth = mode === 'horizontal'
    ? { field: 'height', type: 'spansBetween', overridden: false,
        from: { node: back.id, face: 'front', offset: 0 }, to: { node: front.id, face: 'back', offset: 0 }, id: nextConstraintId() }
    : { field: 'width', type: 'spansBetween', overridden: false,
        from: { node: back.id, face: 'front', offset: 0 }, to: { node: front.id, face: 'back', offset: 0 }, id: nextConstraintId() };

  const shelf = createPanelNode({
    name: mode === 'horizontal' ? 'Shelf (H)' : 'Shelf (V)',
    width: mode === 'horizontal' ? startWidthOrHeight : DEFAULT_BOX_DEPTH_MM,
    height: mode === 'horizontal' ? DEFAULT_BOX_DEPTH_MM : startWidthOrHeight,
    thickness, material, rotation,
    groupId,
    lockedMoveAxes: mode === 'horizontal' ? ['x', 'z'] : ['y', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'], // both dimension fields are constraint-derived (spanToBoundaries/spanToDepth) — same reasoning as box walls, dragging a dot wouldn't stick
    constraints: [spanToBoundaries, spanToDepth],
  });

  shelf.basePosition = anchor;
  shelf.offset = { x: 0, y: 0, z: 0 };
  shelf.offset[freeAxis] = proposedFreeOffset;

  return { ok: true, node: shelf, groupId };
}

// Given same-axis slabs (already sorted ascending by center) and a
// thickness to fit, finds the largest gap between consecutive slabs
// and returns where a new slab's CENTER would sit if placed in the
// middle of that gap, plus how much clear space that gap actually
// has (so the caller can tell "fits" from "doesn't"). Used instead
// of a fixed midpoint so a second/third shelf on the same pair of
// boundaries doesn't always land on top of the first one.
function findBestShelfSlot(sortedSlabs, thickness) {
  let best = null;
  for (let i = 0; i < sortedSlabs.length - 1; i++) {
    const prevOuter = sortedSlabs[i].center + sortedSlabs[i].halfThickness;
    const nextOuter = sortedSlabs[i + 1].center - sortedSlabs[i + 1].halfThickness;
    const clearSpan = nextOuter - prevOuter;
    if (!best || clearSpan > best.clearSpan) {
      best = { center: (prevOuter + nextOuter) / 2, clearSpan };
    }
  }
  return best;
}

// Given same-axis slabs (sorted ascending by center) and a shelf of
// `thickness` to place, finds the gap-clamped center closest to
// `desiredMm` among ONLY the gaps big enough to actually fit the
// shelf with MIN_WALL_GAP_MM clearance on both sides. A gap too
// small to fit is skipped entirely rather than rejecting placement
// outright — a nearby gap not being big enough shouldn't block a
// perfectly good gap further away. Returns { fits:false } only if
// NO gap anywhere on this axis can fit the shelf.
function pickGapForPosition(sortedSlabs, desiredMm, thickness) {
  const halfT = thickness / 2;
  const requiredSpan = thickness + 2 * MIN_WALL_GAP_MM;
  let best = null;

  for (let i = 0; i < sortedSlabs.length - 1; i++) {
    const prevOuter = sortedSlabs[i].center + sortedSlabs[i].halfThickness;
    const nextOuter = sortedSlabs[i + 1].center - sortedSlabs[i + 1].halfThickness;
    const clearSpan = nextOuter - prevOuter;
    if (clearSpan < requiredSpan) continue; // this gap can't hold the shelf at all — try the next one

    const minCenter = prevOuter + MIN_WALL_GAP_MM + halfT;
    const maxCenter = nextOuter - MIN_WALL_GAP_MM - halfT;
    const center = Math.min(maxCenter, Math.max(minCenter, desiredMm)); // exact click point if it already fits, else clamped to the nearest valid spot in THIS gap
    const dist = Math.abs(desiredMm - center);

    if (!best || dist < best.dist) best = { center, dist };
  }

  return best ? { fits: true, center: best.center } : { fits: false };
}

export function isShelf(node) {
  return !!node.groupId && !node.isBoxWall &&
    (rotationsMatch(node.rotation, HORIZONTAL_ROTATION) || rotationsMatch(node.rotation, VERTICAL_ROTATION));
}

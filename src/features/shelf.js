import {createPanelNode, nextConstraintId, MM_TO_UNIT, getAlignedAxis, LOCAL_FACES} from '../modeller/modules.js' 
import {resolveConstraints} from '../modeller/snap.js'
import {findBoxSibling} from './box.js'
import {collectAxisSlabs, checkMinGap, VERTICAL_ROTATION, HORIZONTAL_ROTATION, rotationsMatch} from '../shared/geometry.js' 

export function addShelf(pick1, pick2) {
  const groupId = pick1.groupId;
  const back = findBoxSibling(groupId, 'Back');
  const front = findBoxSibling(groupId, 'Front');
  if (!back || !front) return;

  const resolved = resolveConstraints(panels);
  const r1 = resolved.find((r) => r.id === pick1.id);
  const r2 = resolved.find((r) => r.id === pick2.id);
  if (!r1 || !r2) return;

  const spanAxis = shelfMode === 'horizontal' ? 'x' : 'y';
  const face1 = facingFace(r1, spanAxis, r2);
  const face2 = facingFace(r2, spanAxis, r1);
  if (!face1 || !face2) return;

  const freeAxis = shelfMode === 'horizontal' ? 'y' : 'x';
  const anchor = pick1.basePosition;
  const thickness = pick1.thickness;
  const existingSlabs = collectAxisSlabs(groupId, freeAxis).sort((a, b) => a.center - b.center);

  let proposedFreeOffset;
  if (shelfPick1ClickMm != null) {
    const picked = pickGapForPosition(existingSlabs, shelfPick1ClickMm, thickness);
    if (!picked.fits) {
      showToast('Not enough space for a shelf there');
      return;
    }
    proposedFreeOffset = picked.center;
  } else {
    const slot = findBestShelfSlot(existingSlabs, thickness);
    const requiredSpan = thickness + 2 * MIN_WALL_GAP_MM;
    if (!slot || slot.clearSpan < requiredSpan) {
      showToast('Not enough space for another shelf here');
      return;
    }
    proposedFreeOffset = slot.center;
  }
  const spanFieldForBoundary = shelfMode === 'horizontal' ? 'width' : 'height';
  const startWidthOrHeight = Math.abs(r2.position[spanAxis] - r1.position[spanAxis]);
  const rotation = shelfMode === 'horizontal' ? HORIZONTAL_ROTATION : VERTICAL_ROTATION;
  const material = pick1.material;

  const spanToBoundaries = {
    field: spanFieldForBoundary, type: 'spansBetween', overridden: false,
    from: { node: pick1.id, face: face1, offset: 0 },
    to: { node: pick2.id, face: face2, offset: 0 },
    id: nextConstraintId(),
  };
  const spanToDepth = shelfMode === 'horizontal'
    ? { field: 'height', type: 'spansBetween', overridden: false,
        from: { node: back.id, face: 'front', offset: 0 }, to: { node: front.id, face: 'back', offset: 0 }, id: nextConstraintId() }
    : { field: 'width', type: 'spansBetween', overridden: false,
        from: { node: back.id, face: 'front', offset: 0 }, to: { node: front.id, face: 'back', offset: 0 }, id: nextConstraintId() };

  const shelf = createPanelNode({
    name: shelfMode === 'horizontal' ? 'Shelf (H)' : 'Shelf (V)',
    width: shelfMode === 'horizontal' ? startWidthOrHeight : DEFAULT_BOX_DEPTH_MM,
    height: shelfMode === 'horizontal' ? DEFAULT_BOX_DEPTH_MM : startWidthOrHeight,
    thickness, material, rotation,
    groupId,
    lockedMoveAxes: shelfMode === 'horizontal' ? ['x', 'z'] : ['y', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'], // both dimension fields are constraint-derived (spanToBoundaries/spanToDepth) — same reasoning as box walls, dragging a dot wouldn't stick
    constraints: [spanToBoundaries, spanToDepth],
  });

  shelf.basePosition = anchor;
  shelf.offset = { x: 0, y: 0, z: 0 };
  shelf.offset[freeAxis] = proposedFreeOffset;

  const before = panels;
  panels = [...panels, shelf];
  const after = panels;
  recordHistoryCommand(AddShelfCommand,before,after);
  setSelectedGroupId(groupId);
  setSelectedId(shelf.id);
  renderAll();
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

// Which of a resolved node's LOCAL faces both (a) aligns with `axis`
// and (b) points TOWARD `otherResolved` — i.e. the one face of the
// two possible (+/-) candidates that actually faces the other picked
// boundary, determined from their real current positions rather than
// assumed from role/name. This is what makes picking an existing
// shelf as a boundary work exactly like picking Left/Right/Top/Bottom
// — it doesn't matter which literal side of the box either one is on.
function facingFace(resolved, axis, otherResolved) {
  const towardSign = Math.sign(otherResolved.position[axis] - resolved.position[axis]) || 1;
  for (const faceName of Object.keys(LOCAL_FACES)) {
    const aligned = getAlignedAxis(resolved.rotation, faceName);
    if (aligned && aligned.axis === axis && aligned.sign === towardSign) return faceName;
  }
  return null; // defensive — every panel in this app is axis-aligned, so one of the two candidate faces always matches
}

// Converts a raycast hit point (world units) into an offset-space mm
// value along one axis, relative to the box's shared basePosition —
// same space every shelf/wall offset already lives in.
function computeClickOffsetMm(node, worldPoint, axis) {
  const worldMm = { x: worldPoint.x / MM_TO_UNIT, y: worldPoint.y / MM_TO_UNIT, z: worldPoint.z / MM_TO_UNIT };
  return worldMm[axis] - node.basePosition[axis];
}

export function isShelf(node) {
  return !!node.groupId && !node.isBoxWall &&
    (rotationsMatch(node.rotation, HORIZONTAL_ROTATION) || rotationsMatch(node.rotation, VERTICAL_ROTATION));
}
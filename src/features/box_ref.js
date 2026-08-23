import { setSelectedGroupId, setSelectedId } from "../core/selection.js";
import {createPanelNode,
    computeNextBasePosition,
    MATERIAL_CATALOG,
} from '../core/modules.js';
import {resolveConstraints} from '../core/snap.js';
import {renderAll, 
    updateNode,
    recordHistoryCommand,
    showToast,
    findPanelSizeViolation,
    showPanelSizeLimitError,
    checkMinGap,
    collectAxisSlabs,
} from '../modeller-main.js';


const DEFAULT_BOX_DEPTH_MM = 400;
const DEFAULT_BOX_WIDTH_MM = 500;
const DEFAULT_BOX_HEIGHT_MM = 700;

const BOX_GIZMO_LOCKS = {
  leftRight: {
    lockedMoveAxes: ['y', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: {
      positionY: true,
      positionZ: true,
    },
  },

  topBottom: {
    lockedMoveAxes: ['x', 'z'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: {
      positionX: true,
      positionZ: true,
    },
  },

  frontBack: {
    lockedMoveAxes: ['x', 'y'],
    lockedResizeAxes: ['x', 'y', 'z'],
    lockedFields: {
      positionX: true,
      positionY: true,
    },
  },
};

export function createBox() {
  const W = DEFAULT_BOX_WIDTH_MM;
  const H = DEFAULT_BOX_HEIGHT_MM;
  const D = DEFAULT_BOX_DEPTH_MM;
  const material = MATERIAL_CATALOG[0].name;
  const T = MATERIAL_CATALOG[0].thicknessMm;

  const left = createPanelNode({
    name: 'Left',
    width: D, height: H, thickness: T, material,
    rotation: { x: 0, y: 90, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.leftRight.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.leftRight.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.leftRight.lockedFields },
  });
  const right = createPanelNode({
    name: 'Right',
    width: D, height: H, thickness: T, material,
    rotation: { x: 0, y: 90, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.leftRight.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.leftRight.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.leftRight.lockedFields },
  });
  const top = createPanelNode({
    name: 'Top',
    width: W, height: D, thickness: T, material,
    rotation: { x: 90, y: 0, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.topBottom.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.topBottom.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.topBottom.lockedFields },
  });
  const bottom = createPanelNode({
    name: 'Bottom',
    width: W, height: D, thickness: T, material,
    rotation: { x: 90, y: 0, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.topBottom.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.topBottom.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.topBottom.lockedFields },
  });
  const back = createPanelNode({
    name: 'Back',
    // Covers all 4 outer edges of the assembly (H+2T) — like a real
    // cabinet's solid back sheet, nailed across the whole carcass
    // rather than let into it. Same as the old design; now just a
    // starting value instead of a fixed literal, since relayoutBox()
    // will recompute it (to this exact number, for these inputs) the
    // moment it runs.
    width: W, height: H + 2 * T, thickness: T, material,
    rotation: { x: 0, y: 0, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.frontBack.lockedFields },
  });
  const front = createPanelNode({
    name: 'Front',
    // Inner-fitted footprint — grooved between the sides, W-2T.
    width: W - 2 * T, height: H, thickness: T, material,
    rotation: { x: 0, y: 0, z: 0 },
    isBoxPanel: true,
    isBoxWall: true,
    lockedMoveAxes: BOX_GIZMO_LOCKS.frontBack.lockedMoveAxes,
    lockedResizeAxes: BOX_GIZMO_LOCKS.frontBack.lockedResizeAxes,
    lockedFields: { ...BOX_GIZMO_LOCKS.frontBack.lockedFields },
  });

  const boxPanels = [left, right, top, bottom, back, front];
  boxPanels.forEach((p) => { p.groupId = left.id; }); // left's own id doubles as the group's identifier — no separate id generator needed

  // All 6 box panels share ONE basePosition — the box's own single
  // far-right placement slot (treating its WxH front footprint like
  // one panel for that purpose) — rather than each independently
  // claiming its own row slot the way plain "add panel" does.
  // computeBoxLayout() (and therefore relayoutBox()) works entirely
  // in offset-space relative to this shared anchor, so the anchor
  // itself is never touched again after this. 
  const anchor = computeNextBasePosition(resolveConstraints(panels), { width: W, height: H, thickness: T, rotation: { x: 0, y: 0, z: 0 } });
  anchor.y = H / 2 + T;
  boxPanels.forEach((p) => { p.basePosition = anchor; });

  // Starting offsets — each wall's OWN driving axis, same numbers the
  // old design used. Every other offset field gets overwritten by
  // relayoutBox() immediately below regardless of what's set here.
  left.offset = { x: -(W / 2 - T / 2), y: 0, z: 0 };
  right.offset = { x: +(W / 2 - T / 2), y: 0, z: 0 };
  bottom.offset = { x: 0, y: -H / 2 - T / 2, z: 0 };
  top.offset = { x: 0, y: +H / 2 + T / 2, z: 0 };
  back.offset = { x: 0, y: 0, z: -D / 2 - T / 2 };
  front.offset = { x: 0, y: 0, z: +D / 2 + T / 2 };

  const before = panels;
  panels = [...panels, ...boxPanels];
  relayoutBox(left.id);
  updateNode(front.id, { hidden: true });
  const after = panels;
  recordHistoryCommand(AddBoxCommand, before, after);

  setSelectedGroupId(left.id);
  setSelectedId(null);
  renderAll();
}

// ---- BOX LAYOUT (Stage 3) ----
// Pure function: given the box's 6 wall nodes (each just needs
// .thickness and .offset), returns each wall's new width/height/
// offset so the assembly stays airtight no matter which wall(s) were
// dragged. Only left.offset.x / right.offset.x / top.offset.y /
// bottom.offset.y / back.offset.z / front.offset.z are ever treated
// as "driving" values — everything else here is derived. All
// measurements are in OFFSET space (relative to the box's shared
// basePosition anchor) — it cancels out of every difference used
// here, so the anchor itself is never read.
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
  const outerHeight = yOuterMax - yOuterMin;
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

export function relayoutBox(groupId) {
  const roles = {
    left: findBoxSibling(groupId, 'Left'), right: findBoxSibling(groupId, 'Right'),
    top: findBoxSibling(groupId, 'Top'), bottom: findBoxSibling(groupId, 'Bottom'),
    back: findBoxSibling(groupId, 'Back'), front: findBoxSibling(groupId, 'Front'),
  };
  if (Object.values(roles).some((n) => !n)) return true;

  const layout = computeBoxLayout(roles);

  for (const [role, node] of Object.entries(roles)) {
    const dims = { width: layout[role].width, height: layout[role].height, thickness: node.thickness };
    if (dims.width < MIN_PANEL_DIM_MM || dims.height < MIN_PANEL_DIM_MM) {
      showToast("Can't shrink the box that far — walls would overlap");
      return false;
    }
    const sizeViolation = findPanelSizeViolation(dims);
    if (sizeViolation) { showPanelSizeLimitError(sizeViolation); return false; }
    const positionMm = {
      x: node.basePosition.x + layout[role].offset.x,
      y: node.basePosition.y + layout[role].offset.y,
      z: node.basePosition.z + layout[role].offset.z,
    };
    const hitAxis = findDesignLimitViolation(node.rotation, positionMm, dims);
    if (hitAxis) { showDesignLimitError(hitAxis); return false; }
  }

  const yCheck = checkMinGap(collectAxisSlabs(groupId, 'y', {
    [roles.bottom.id]: { center: layout.bottom.offset.y, halfThickness: roles.bottom.thickness / 2, label: 'Bottom' },
    [roles.top.id]:    { center: layout.top.offset.y,    halfThickness: roles.top.thickness / 2,    label: 'Top' },
  }));
  if (!yCheck.ok) {
    showToast(`Can't fit — ${yCheck.a} and ${yCheck.b} would be closer than ${MIN_WALL_GAP_MM}mm`);
    return false;
  }

  const xCheck = checkMinGap(collectAxisSlabs(groupId, 'x', {
    [roles.left.id]:  { center: layout.left.offset.x,  halfThickness: roles.left.thickness / 2,  label: 'Left' },
    [roles.right.id]: { center: layout.right.offset.x, halfThickness: roles.right.thickness / 2, label: 'Right' },
  }));
  if (!xCheck.ok) {
    showToast(`Can't fit — ${xCheck.a} and ${xCheck.b} would be closer than ${MIN_WALL_GAP_MM}mm`);
    return false;
  }

  for (const [role, node] of Object.entries(roles)) {
    updateNode(node.id, { width: layout[role].width, height: layout[role].height, offset: layout[role].offset });
  }
  return true;
}

// Box siblings are found by groupId + role name (see addBox — every
// box panel is named exactly 'Left'/'Right'/'Top'/'Bottom'/'Back'/
// 'Front') rather than by any stored per-role id list, since that's
// already the single source of truth addBox itself relies on. Always
// the box's REAL Back/Front — a shelf's depth always reaches the
// actual box walls/door, never another shelf, regardless of which
// two boundary panels were picked for width/height.
export function findBoxSibling(groupId, name) {
  return panels.find((p) => p.groupId === groupId && p.name === name);
}


/**
 * features/box.js
 *
 * Everything that defines what a BOX is: creation, the carcass layout
 * math, and relayout after a wall drag/resize/material change.
 *
 * PURE MODULE — nothing here touches the global `panels` array or
 * calls history/render. Every function takes the data it needs as
 * arguments and returns data. modeller-main.js remains the single
 * writer (per its own file-header rule) — it applies whatever this
 * module returns.
 *
 * Box wall convention (STAGE 3 — no constraints on box walls, see
 * modeller-main.js's own header comment for why):
 *   - Left/Right:   VERTICAL_ROTATION,   free axis X, full height + depth
 *   - Top/Bottom:   HORIZONTAL_ROTATION, free axis Y, inset between Left/Right
 *   - Back/Front:   PARALLEL_ROTATION,   free axis Z, inset within all four
 *   - Front starts hidden:true — "open-front box" means the panel
 *     exists (restorable via the group inspector) but isn't shown.
 *
 * Each wall's ONE free axis is where a drag/typed-offset edit is
 * allowed to move it (see LOCKS below); relayoutBox() recomputes
 * every other wall's width/height/offset to match once that one
 * value has changed.
 */
import {resolveConstraints} from '../modeller/snap.js'
import {createPanelNode,
    computeWorldHalfExtents,
    MM_TO_UNIT,
    DESIGN_LIMITS_MM,
    PANEL_SIZE_LIMITS_MM,
    MATERIAL_CATALOG,
    LOCAL_FACES} from '../modeller/modules.js'
import {checkMinGap,
    collectAxisSlabs,
    findPanelSizeViolation,
    findDesignLimitViolation,
    VERTICAL_ROTATION,
    HORIZONTAL_ROTATION,
    PARALLEL_ROTATION} from '../shared/geometry.js'

export const DEFAULT_BOX_WIDTH_MM = 500;
export const DEFAULT_BOX_HEIGHT_MM = 700;
export const DEFAULT_BOX_DEPTH_MM = 400;

// Which axes are locked (i.e. NOT the wall's free axis) per role pair.
// lockedResizeAxes is always all three — no box wall's width/height is
// ever user-resizable directly; only relayoutBox() (driven by a drag
// on the free axis, or a material/thickness change) is allowed to
// change those fields. See updateSelectedField's isBoxWall guard in
// modeller-main.js.
const WALL_LOCKS = {
  Left:   { lockedMoveAxes: ['y', 'z'], lockedResizeAxes: ['x', 'y', 'z'], lockedFields: { positionY: true, positionZ: true } },
  Right:  { lockedMoveAxes: ['y', 'z'], lockedResizeAxes: ['x', 'y', 'z'], lockedFields: { positionY: true, positionZ: true } },
  Top:    { lockedMoveAxes: ['x', 'z'], lockedResizeAxes: ['x', 'y', 'z'], lockedFields: { positionX: true, positionZ: true } },
  Bottom: { lockedMoveAxes: ['x', 'z'], lockedResizeAxes: ['x', 'y', 'z'], lockedFields: { positionX: true, positionZ: true } },
  Back:   { lockedMoveAxes: ['x', 'y'], lockedResizeAxes: ['x', 'y', 'z'], lockedFields: { positionX: true, positionY: true } },
  Front:  { lockedMoveAxes: ['x', 'y'], lockedResizeAxes: ['x', 'y', 'z'], lockedFields: { positionX: true, positionY: true } },
};

const ROLE_ROTATION = {
  Left: VERTICAL_ROTATION, Right: VERTICAL_ROTATION,
  Top: HORIZONTAL_ROTATION, Bottom: HORIZONTAL_ROTATION,
  Back: PARALLEL_ROTATION, Front: PARALLEL_ROTATION,
};

/**
 * Pure carcass math: given outer box dimensions and each wall's
 * thickness, returns the width/height/offset every one of the 6
 * walls should have. offsets are relative to the box's own
 * basePosition (its center), same space every other offset in the
 * app already lives in.
 *
 * NOTE: this is the piece I had to infer — your actual inset/overlay
 * convention may differ. If it does, only this function needs to
 * change; createBox/relayoutBox below don't care about the specific
 * math, only that it returns { width, height, offset } per role.
 */
export function computeBoxLayout({ width, height, depth, thickness }) {
  const t = thickness; // { Left, Right, Top, Bottom, Back, Front }
  const innerWidth = width - t.Left - t.Right;
  const innerHeight = height - t.Top - t.Bottom;

  return {
    Left: {
      width: depth, height, thickness: t.Left,
      offset: { x: -(width / 2 - t.Left / 2), y: 0, z: 0 },
    },
    Right: {
      width: depth, height, thickness: t.Right,
      offset: { x: (width / 2 - t.Right / 2), y: 0, z: 0 },
    },
    Bottom: {
      width: innerWidth, height: depth, thickness: t.Bottom,
      offset: { x: 0, y: -(height / 2 - t.Bottom / 2), z: 0 },
    },
    Top: {
      width: innerWidth, height: depth, thickness: t.Top,
      offset: { x: 0, y: (height / 2 - t.Top / 2), z: 0 },
    },
    // Back/Front are inset within all four other walls (captured
    // construction) — width/height shrink by the LEFT/RIGHT and
    // TOP/BOTTOM thicknesses on top of the box's own inner span.
    Back: {
      width: innerWidth, height: innerHeight, thickness: t.Back,
      offset: { x: 0, y: 0, z: -(depth / 2 - t.Back / 2) },
    },
    Front: {
      width: innerWidth, height: innerHeight, thickness: t.Front,
      offset: { x: 0, y: 0, z: (depth / 2 - t.Front / 2) },
    },
  };
}

/**
 * Creates a new box: 6 panel nodes (left, right, top, bottom, back,
 * front), grouped, with Front hidden by default. Pure — returns the
 * nodes and the groupId; does not touch global panels, history, or
 * rendering. Caller (modeller-main.js) is responsible for committing
 * via its single commit path.
 */
export function addBox({
  width = DEFAULT_BOX_WIDTH_MM,
  height = DEFAULT_BOX_HEIGHT_MM,
  depth = DEFAULT_BOX_DEPTH_MM,
  material,
  basePosition = { x: 0, y: 0, z: 0 },
} = {}) {
  const materialName = material ?? MATERIAL_CATALOG[0]?.name;
  const catalogEntry = MATERIAL_CATALOG.find((m) => m.name === materialName);
  const thicknessMm = catalogEntry?.thicknessMm ?? 18;

  const thickness = { Left: thicknessMm, Right: thicknessMm, Top: thicknessMm, Bottom: thicknessMm, Back: thicknessMm, Front: thicknessMm };
  const layout = computeBoxLayout({ width, height, depth, thickness });

  const roles = ['Left', 'Right', 'Top', 'Bottom', 'Back', 'Front'];
  const wallsByRole = {};

  roles.forEach((role) => {
    const l = layout[role];
    const node = createPanelNode({
      name: role,
      width: l.width,
      height: l.height,
      thickness: l.thickness,
      material: materialName,
      rotation: ROLE_ROTATION[role],
      isBoxWall: true,
      hidden: role === 'Front', // open-front box — panel exists, restorable
      constraints: [], // Stage 3: box walls carry no constraints
      ...WALL_LOCKS[role],
    });
    node.basePosition = basePosition;
    node.offset = l.offset;
    wallsByRole[role] = node;
  });

  // groupId = one member's own id — same trick used elsewhere for
  // ad-hoc groups (see groupSelectedPanels in modeller-main.js).
  const groupId = wallsByRole.Left.id;
  roles.forEach((role) => { wallsByRole[role].groupId = groupId; });

  return { nodes: roles.map((role) => wallsByRole[role]), groupId };
}

/** Find a specific wall of a box by its role name ('Back', 'Front', etc). */
export function findBoxSibling(panels, groupId, role) {
  return panels.find((p) => p.groupId === groupId && p.isBoxWall && p.name === role) || null;
}

/**
 * Recomputes every wall of a box after one wall's free-axis offset
 * has already changed in the CALLER's proposed state (relayoutBox
 * doesn't itself decide which wall moved or by how much — it derives
 * the box's current W/H/D from whatever offsets are already on the 6
 * walls in `panels`, then recomputes every wall to match).
 *
 * Pure: returns either
 *   { ok: true, patches: [{ id, width, height, offset }, ...] }
 * or
 *   { ok: false, hitAxis } | { ok: false, reason }
 * and mutates nothing. modeller-main.js applies the patches via
 * updateNode() and decides history/render — same single-writer rule
 * as everywhere else in this app.
 *
 * Validates against PANEL_SIZE_LIMITS_MM, DESIGN_LIMITS_MM, and
 * MIN_WALL_GAP_MM against any shelves already inside the box, for
 * every wall — a single wall's edit can never leave the box partially
 * updated or overlapping its own contents.
 */
export function relayoutBox(panels, groupId) {
  const roles = ['Left', 'Right', 'Top', 'Bottom', 'Back', 'Front'];
  const walls = {};
  for (const role of roles) {
    const w = findBoxSibling(panels, groupId, role);
    if (!w) return { ok: false, reason: `missing wall: ${role}` };
    walls[role] = w;
  }

  // Derive current outer W/H/D from the walls' own offsets + thickness.
  const width = (walls.Right.offset.x + walls.Right.thickness / 2) - (walls.Left.offset.x - walls.Left.thickness / 2);
  const height = (walls.Top.offset.y + walls.Top.thickness / 2) - (walls.Bottom.offset.y - walls.Bottom.thickness / 2);
  const depth = (walls.Front.offset.z + walls.Front.thickness / 2) - (walls.Back.offset.z - walls.Back.thickness / 2);

  const thickness = Object.fromEntries(roles.map((r) => [r, walls[r].thickness]));
  const layout = computeBoxLayout({ width, height, depth, thickness });

  const patches = roles.map((role) => ({
    id: walls[role].id,
    width: layout[role].width,
    height: layout[role].height,
    offset: layout[role].offset,
  }));

  // Validate every wall: panel size cap, design limits, and clearance
  // against any shelves sharing its axis.
  for (const role of roles) {
    const patch = patches.find((p) => p.id === walls[role].id);
    const dims = { width: patch.width, height: patch.height, thickness: walls[role].thickness };

    const sizeViolation = findPanelSizeViolation(dims);
    if (sizeViolation) return { ok: false, reason: `panel-size:${sizeViolation}` };

    const positionMm = {
      x: walls[role].basePosition.x + patch.offset.x,
      y: walls[role].basePosition.y + patch.offset.y,
      z: walls[role].basePosition.z + patch.offset.z,
    };
    const hitAxis = findDesignLimitViolation(ROLE_ROTATION[role], positionMm, dims);
    if (hitAxis) return { ok: false, hitAxis };
  }

  // Clearance check: Top/Bottom moving must not collide with any
  // horizontal shelf inside; Left/Right moving must not collide with
  // any vertical shelf. Only these two axes have interior shelves to
  // worry about — Back/Front's free axis (depth) has no shelves
  // spanning it.
  for (const [axis, lowRole, highRole] of [['y', 'Bottom', 'Top'], ['x', 'Left', 'Right']]) {
    const lowPatch = patches.find((p) => p.id === walls[lowRole].id);
    const highPatch = patches.find((p) => p.id === walls[highRole].id);
    const overrides = {
      [walls[lowRole].id]: { center: lowPatch.offset[axis], halfThickness: walls[lowRole].thickness / 2, label: lowRole },
      [walls[highRole].id]: { center: highPatch.offset[axis], halfThickness: walls[highRole].thickness / 2, label: highRole },
    };
    const slabs = collectAxisSlabs(panels, groupId, axis, overrides);
    const gapCheck = checkMinGap(slabs);
    if (!gapCheck.ok) return { ok: false, reason: `min-gap:${gapCheck.a}/${gapCheck.b}` };
  }

  return { ok: true, patches };
}

/**
 * Graph node definitions for the modeller.
 *
 * STAGE 2: nodes now carry an optional `constraints` array. Each
 * constraint targets exactly one field ('width' | 'height' |
 * 'thickness' | 'positionX' | 'positionY' | 'positionZ') and is
 * either:
 *
 *   spansBetween — this field's VALUE is the distance between two
 *   referenced faces (used for width/height/thickness).
 *
 *   attachedTo — this field's VALUE is derived from touching one of
 *   THIS node's own faces (`myFace`) against one referenced face
 *   (used for positionX/positionY/positionZ).
 *
 * A face reference is always the same shape — { node, face, offset }
 * — a normal+offset representation: `face` names one of the six
 * LOCAL_FACES below, and `offset` (mm) shifts the reference point
 * outward along that face's own normal. Offset defaults to 0 (flush
 * contact); a positive value is what an inset/rabbet joint would use
 * later, so this doesn't need to change shape when that's built.
 *
 * `overridden: true` means the user manually edited a field that
 * used to be governed by this constraint — the resolver skips it
 * (keeps the literal value on the node) but the constraint's
 * definition is NOT deleted, so it's still visible/re-linkable later.
 *
 * Every existing panel (no `constraints`) keeps working exactly as
 * before — this is additive, not a breaking migration.
 */

import * as THREE from 'three';

let idCounter = 1;

export function nextId() {
  return `panel-${idCounter++}`;
}

// Guard against degenerate (zero/negative) panel geometry — used
// wherever a dimension can be derived from user interaction (the
// scale gizmo, the box preset, and now the constraint resolver).
// One shared constant so all three can never quietly drift apart.
export const MIN_PANEL_DIM_MM = 10;

/**
 * Canonical face vocabulary, in each panel's own LOCAL (unrotated)
 * frame — width along X, height along Y, thickness along Z, exactly
 * as BoxGeometry(width, height, thickness) lays it out before any
 * rotation is applied. Defining faces here, once, is what lets
 * constraints, edge-banding, and hole placement (later stages) all
 * reference the same six names instead of each inventing their own
 * — and keeps face identity independent of whatever `rotation` a
 * panel currently has: flipping a panel's orientation preset must
 * never redefine which physical edge is "top".
 *
 * The resolver combines a face's local normal with the target node's
 * ACTUAL rotation to get a world-space direction, and requires that
 * result to land on an axis (within a small tolerance) — general
 * angled joinery (a face resolved against a non-axis-aligned target)
 * is explicitly unsupported for now. When that happens the resolver
 * raises a clear, named warning rather than silently producing wrong
 * geometry; see snap.js. Lifting that restriction later only means
 * extending the resolver's math — this vocabulary doesn't change.
 */
export const LOCAL_FACES = {
  right:  { x: 1, y: 0, z: 0 },   // +width axis
  left:   { x: -1, y: 0, z: 0 },
  top:    { x: 0, y: 1, z: 0 },   // +height axis
  bottom: { x: 0, y: -1, z: 0 },
  front:  { x: 0, y: 0, z: 1 },   // +thickness axis — the "show" face
  back:   { x: 0, y: 0, z: -1 },
};

// Which of a panel's own literal dimension fields a given LOCAL face
// belongs to — e.g. the 'right'/'left' faces sit at ±width/2. The
// resolver uses this to find a face's distance from its node's own
// center, regardless of which specific face was chosen.
export const FACE_TO_DIM_FIELD = {
  right: 'width', left: 'width',
  top: 'height', bottom: 'height',
  front: 'thickness', back: 'thickness',
};

// Which world axis a constrainable field corresponds to.
export const FIELD_TO_AXIS = {
  width: 'x', height: 'y', thickness: 'z',
  positionX: 'x', positionY: 'y', positionZ: 'z',
};

const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/**
 * Which single world axis (if any) a local face lands on, given a
 * node's rotation. Returns { axis: 'x'|'y'|'z', sign: 1|-1 }, or null
 * if the face isn't aligned with any single axis within tolerance
 * (general angled joinery is unsupported — see LOCAL_FACES above).
 * Lives here (not snap.js) because createPanelNode uses it directly
 * to compute thicknessAxis at creation time; snap.js's resolver also
 * uses it for constraint alignment checks, imported from here.
 */
export function getAlignedAxis(rotationDeg, faceName) {
  const local = LOCAL_FACES[faceName];
  if (!local) return null;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg?.x || 0),
    THREE.MathUtils.degToRad(rotationDeg?.y || 0),
    THREE.MathUtils.degToRad(rotationDeg?.z || 0)
  );
  const worldNormal = new THREE.Vector3(local.x, local.y, local.z).applyEuler(euler);
  for (const axis of ['x', 'y', 'z']) {
    const alignment = worldNormal.dot(AXIS_VECTORS[axis]);
    if (Math.abs(Math.abs(alignment) - 1) <= 0.02) {
      return { axis, sign: alignment >= 0 ? 1 : -1 };
    }
  }
  return null;
}

/**
 * Classifies a panel's six faces by whether THICKNESS is one of that
 * face's two edge lengths:
 *   - flatFaces (2): the faces perpendicular to the thickness axis
 *     itself ('front'/'back' in the local vocabulary) — their edges
 *     are width×height, thickness never appears as an edge on them.
 *   - edgeFaces (4): the other four — each has thickness as one of
 *     its two edges (e.g. 'right'/'left' are height×thickness,
 *     'top'/'bottom' are width×thickness). These are the faces edge
 *     banding would apply to.
 * Works from node.thicknessAxis if present (the normal case — every
 * node has one from creation onward), falling back to computing it
 * fresh from node.rotation otherwise.
 */
export function classifyFacesByThickness(node) {
  const thicknessAxis = node.thicknessAxis || getAlignedAxis(node.rotation, 'front')?.axis || 'z';
  const edgeFaces = [];
  const flatFaces = [];
  Object.keys(LOCAL_FACES).forEach((faceName) => {
    const aligned = getAlignedAxis(node.rotation, faceName);
    if (aligned && aligned.axis === thicknessAxis) flatFaces.push(faceName);
    else edgeFaces.push(faceName);
  });
  return { thicknessAxis, edgeFaces, flatFaces };
}

let constraintIdCounter = 1;
export function nextConstraintId() {
  return `c${constraintIdCounter++}`;
}

/**
 * PLACEHOLDER catalog — replace with the real curated SKU list (per
 * the project's own plan: hand-curated TOSIZE/Panobois materials,
 * eventually a YAML file per category). Each entry's thicknessMm is
 * the single source of truth for what a panel's thickness becomes
 * when that material is selected — see modeller-main.js's
 * updateSelectedField('material', ...), the ONLY place thickness is
 * ever allowed to change after a panel is created.
 */
export const MATERIAL_CATALOG = [
  { name: 'Melamine White 18mm', thicknessMm: 18 },
  { name: 'Melamine Oak 18mm', thicknessMm: 18 },
  { name: 'MDF Raw 18mm', thicknessMm: 18 },
  { name: 'MDF Raw 25mm', thicknessMm: 25 },
  { name: 'Plywood Birch 12mm', thicknessMm: 12 },
  { name: 'Plywood Birch 18mm', thicknessMm: 18 },
  { name: 'Hardboard Back Panel 6mm', thicknessMm: 6 },
];

export function createPanelNode(overrides = {}) {
  const rotation = overrides.rotation || { x: 0, y: 90, z: 0 };
  const node = {
    id: nextId(),
    type: 'panel',
    name: null,                          // optional friendly label; id stays the stable reference key
    width: 350,     // mm — maps to world Z ("depth") once rotated into the YZ plane below
    height: 350,    // mm — maps to world Y; equal to width by default, so the visible face is square
    thickness: 18,  // mm — the small, BOM-fixed board thickness; maps to world X once rotated
    material: 'Melamine White 18mm',
    quantity: 1,
    offset: { x: 0, y: 0, z: 0 },       // mm, delta from basePosition (see below) — this is what drags/resizes ever touch
    basePosition: { x: 0, y: 0, z: 0 }, // mm — set ONCE at creation (see computeNextBasePosition) and never recomputed afterward, by anything. This is what makes existing panels immune to being nudged by later edits elsewhere in the scene.
    rotation,                           // degrees — default orientation lies in the YZ plane (see above)
    constraints: [],                    // Stage 2: see file header
    groupId: null,                      // shared by all panels of a preset-created group (e.g. the box) — null for a standalone panel. Deleting a member of a group HIDES it (see below) rather than removing it; deleting the whole group is a real, permanent removal — see modeller-main.js's removeSelected.
    hidden: false,                      // soft-delete: excluded from rendering, the panel list, and the BOM, but still fully present in the graph (constraints still resolve against it) — restorable via the group-selected inspector view's per-face buttons. Only ever set on a panel that belongs to a group; a standalone panel's Delete is a real removal.
    ...overrides,
  };
  // Always derived from the node's OWN final rotation, never taken
  // from overrides directly — thicknessAxis must never disagree with
  // rotation, so it isn't independently settable. Since rotation is
  // fixed for the node's whole lifetime (no rotation UI exists
  // anywhere in the app), this is computed once, here, and then just
  // read everywhere else — see classifyFacesByThickness() above for
  // "which faces have thickness as an edge" given this axis.
  node.thicknessAxis = getAlignedAxis(node.rotation, 'front')?.axis || 'z';
  return node;
}

// Used anywhere a panel needs to be shown to a person (list, inspector,
// relation descriptions) — falls back to the stable id when no custom
// name has been set. Constraints/relations always store the id, never
// the name, so renaming a panel can never break a reference.
export function getDisplayName(node) {
  return (node && node.name) || (node ? node.id : '');
}

// Three.js scene unit = 1 metre; graph values are always mm.
export const MM_TO_UNIT = 1 / 1000;

/**
 * Placement for a BRAND NEW panel only. Unlike the old auto-layout
 * (which recomputed every existing panel's position from the whole
 * row's current widths — meaning any resize, or any add/remove
 * anywhere, could nudge panels that were never touched), this is
 * called exactly ONCE, at creation time, and its result is stored
 * permanently on the new node as `basePosition`. Nothing ever
 * recomputes an existing node's basePosition afterward — resize
 * changes `width`/`height`/`thickness` plus `offset` (to keep the
 * un-dragged edge/face anchored, see gizmos.js/view2d.js), never
 * `basePosition`; adding or removing a constraint only changes which
 * constraint governs a field, never where an unconstrained panel's
 * base sits.
 *
 * New panels go to the far right of everything that currently
 * exists, with a fixed clearance margin — not tucked into a
 * continuously-recentered row. `resolvedPanels` should be the output
 * of resolveConstraints(), so "current right edge" reflects each
 * panel's TRUE position (constraints, offset, and any manual drag),
 * not just where it started out.
 */
// Representative face for each dimension field — used to find which
// WORLD axis a given field currently lines up with, given a node's
// rotation. Single source of truth so this doesn't drift between the
// several places that need it (constraint inference, design-limit
// checks, and — the bug this comment is attached to fixing —
// far-right placement, below).
export const DIM_FIELD_PROBE_FACE = { width: 'right', height: 'top', thickness: 'front' };

/**
 * A panel's half-size along each WORLD axis, not its local width/
 * height/thickness — e.g. a Vertical panel's `width` actually extends
 * along world Z, not X; its true X-extent is its `thickness`. Used
 * both for design-limit checks (modeller-main.js) and for correct
 * far-right placement (computeNextBasePosition, below) — the latter
 * used to just read node.width/node.height directly regardless of
 * rotation, which was flat wrong for anything but a Horizontal-
 * oriented panel or footprint.
 */
export function computeWorldHalfExtents(node) {
  const halfExtents = { x: 0, y: 0, z: 0 };
  ['width', 'height', 'thickness'].forEach((field) => {
    const aligned = getAlignedAxis(node.rotation, DIM_FIELD_PROBE_FACE[field]);
    if (aligned) halfExtents[aligned.axis] = node[field] / 2;
  });
  return halfExtents;
}

const NEW_PANEL_MARGIN_MM = 300;
export const FLOOR_MM = 0.0 //-0.5 / MM_TO_UNIT; // preserves the old auto-layout's "sits on the floor" convention

/**
 * DESIGN limits — the overall space a design is allowed to occupy,
 * not a view/camera/clipping limit. X starts at 0 to match the
 * left-to-right auto-layout new panels are placed with; Y is
 * expressed relative to FLOOR_MM (floor-to-ceiling height, matching
 * the existing "sits on the floor" convention); Z is centered on 0
 * (depth extends equally either side of the design's front/back
 * reference plane). Any edit — typed field, drag-move, or drag-resize
 * — that would push a panel outside these is rejected; see
 * modeller-main.js.
 */
export const DESIGN_LIMITS_MM = {
  x: { min: -3000, max: 3000 },
  y: { min: FLOOR_MM, max: FLOOR_MM + 3000 },
  z: { min: -3000, max: 3000 },
};

/**
 * PANEL size limits — caps on a single panel's own `width`/`height`
 * fields, independent of DESIGN_LIMITS_MM above (which bounds the
 * overall scene, not any one panel). Checked at every width/height
 * edit entry point in modeller-main.js: typed inspector fields and
 * resize drags (3D face-drag + 2D edge-drag), both of which funnel
 * through onDimensionChange/updateSelectedField.
 */
export const PANEL_SIZE_LIMITS_MM = {
  width: 1500,
  height: 2000,
};

/**
 * Floor safety clamp — guarantees an object's floor-resting center Y
 * (halfExtentY + FLOOR_MM) is never pushed below FLOOR_MM itself,
 * i.e. its bottom edge never sinks below the floor plane. Kept as a
 * standalone export so any caller assembling its own basePosition by
 * hand (e.g. addBox's shared multi-panel anchor) can apply the same
 * guarantee instead of trusting arithmetic to stay correct.
 */
export function clampToFloor(y, halfExtentY) {
  return Math.max(y, halfExtentY + FLOOR_MM);
}

export function computeNextBasePosition(resolvedPanels, newDims) {
  let maxRightEdgeMm = null;
  resolvedPanels.forEach((node) => {
    const halfExtents = computeWorldHalfExtents(node);
    const rightEdgeMm = node.position.x + halfExtents.x;
    if (maxRightEdgeMm === null || rightEdgeMm > maxRightEdgeMm) maxRightEdgeMm = rightEdgeMm;
  });

  const newHalfExtents = computeWorldHalfExtents(newDims); // newDims is a node-like object with width/height/thickness/rotation, not a real node yet
  const leftEdgeMm = maxRightEdgeMm === null ? 0 : maxRightEdgeMm + NEW_PANEL_MARGIN_MM;
  return {
    x: leftEdgeMm + newHalfExtents.x,
    y: newHalfExtents.y + FLOOR_MM, // sits on the floor
    z: 0,
  };
}

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

let constraintIdCounter = 1;
export function nextConstraintId() {
  return `c${constraintIdCounter++}`;
}

export function createPanelNode(overrides = {}) {
  return {
    id: nextId(),
    type: 'panel',
    width: 600,     // mm
    height: 400,    // mm
    thickness: 18,  // mm
    material: 'Melamine White 18mm',
    quantity: 1,
    offset: { x: 0, y: 0, z: 0 },       // mm, delta from auto-layout position
    rotation: { x: 0, y: 0, z: 0 },     // degrees
    constraints: [],                    // Stage 2: see file header
    ...overrides,
  };
}

// Three.js scene unit = 1 metre; graph values are always mm.
export const MM_TO_UNIT = 1 / 1000;

const PANEL_GAP_UNITS = 0.15; // placeholder spacing until every panel is constraint-driven

/**
 * Auto-layout FALLBACK: lines up, along X, ground-level Y, any panel
 * that has no active position constraint on a given axis. This is
 * the single source of truth for "where would this node sit if
 * nothing constrains it" — the resolver (snap.js) calls this once
 * and only overrides the axes that a constraint actually governs,
 * so a panel with (say) only a width constraint still gets a sane
 * auto position on all three axes.
 */
export function computeAutoLayoutPositions(panels) {
  let cursorX = 0;
  const autoX = new Map();
  panels.forEach((node) => {
    const wUnits = node.width * MM_TO_UNIT;
    autoX.set(node.id, cursorX + wUnits / 2);
    cursorX += wUnits + PANEL_GAP_UNITS;
  });
  const totalWidth = cursorX - PANEL_GAP_UNITS;
  const offsetX = -totalWidth / 2;

  const positions = new Map();
  panels.forEach((node) => {
    const h = node.height * MM_TO_UNIT;
    positions.set(node.id, {
      x: autoX.get(node.id) + offsetX,
      y: h / 2 - 0.5,
      z: 0,
    });
  });
  return positions;
}

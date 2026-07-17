/**
 * Graph node definitions for the modeller.
 *
 * Stage 0/1: a single node type — the rectangular panel — with
 * only literal-valued fields (no relationships to other nodes).
 * That comes in Stage 2 as a `spans_between` / `attached_to`
 * field referencing other node ids.
 *
 * `offset` / `rotation` follow the "manual override" pattern used
 * for dimensions, but expressed as a DELTA from the computed
 * auto-layout position rather than an absolute coordinate:
 *   final position = auto-layout position + offset
 * That's what makes {x:0,y:0,z:0} always mean "exactly where
 * auto-layout would have put it" — zeroing offset and rotation
 * restores the original position/orientation with no separate
 * bookkeeping needed.
 */

let idCounter = 1;

export function nextId() {
  return `panel-${idCounter++}`;
}

// Guard against degenerate (zero/negative) panel geometry — used
// wherever a dimension can be derived from user interaction (the
// scale gizmo, the box preset, and later the constraint resolver).
// One shared constant so all three can never quietly drift apart.
export const MIN_PANEL_DIM_MM = 10;

/**
 * Canonical face vocabulary, in each panel's own LOCAL (unrotated)
 * frame — width along X, height along Y, thickness along Z, exactly
 * as BoxGeometry(width, height, thickness) lays it out before any
 * rotation is applied. Defining faces here, once, is what lets
 * constraints (Stage 2), edge-banding, and hole placement (Stage 5)
 * all reference the same six names instead of each inventing its
 * own — and keeps face identity independent of whatever `rotation`
 * a panel currently has (see LOCAL_FACES doc below).
 *
 * The resolver is responsible for combining a face's local normal
 * with a node's actual rotation to get a world-space direction —
 * nothing here does that projection, on purpose, since "which way
 * is my own top edge" must never change just because a panel got
 * flipped into the "horizontal" orientation preset.
 */
export const LOCAL_FACES = {
  right:  { x: 1, y: 0, z: 0 },   // +width axis
  left:   { x: -1, y: 0, z: 0 },
  top:    { x: 0, y: 1, z: 0 },   // +height axis
  bottom: { x: 0, y: -1, z: 0 },
  front:  { x: 0, y: 0, z: 1 },   // +thickness axis — the "show" face
  back:   { x: 0, y: 0, z: -1 },
};

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
    ...overrides,
  };
}

// Three.js scene unit = 1 metre; graph values are always mm.
export const MM_TO_UNIT = 1 / 1000;

const PANEL_GAP_UNITS = 0.15; // placeholder spacing until Stage 2 relations exist

/**
 * Auto-layout placeholder: lines panels up along X, ground-level Y.
 * This is the single source of truth for "where would this node sit
 * if nobody had moved it" — both the 3D view (scene.js) and the box
 * preset generator (which needs to compute an offset that cancels
 * this out) call this same function, so they can never disagree.
 * Replaced entirely once Stage 2's spans_between relations exist.
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

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

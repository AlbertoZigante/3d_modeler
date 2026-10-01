/**
 * ui/doorSchema.js
 *
 * Visual door schema — a frame (outer rect, the boundary opening)
 * with the door panel (inner rect) inside it, a handle (solid
 * vertical line) opposite the hinge, and a dotted line on the hinge
 * side that swaps them when clicked. The inner rect's own edges move
 * to match each edge's in/out state — an 'out' edge is drawn flush
 * with the outer rect (the door overlays the boundary there), an
 * 'in' edge stays inset — so the shape itself, not just the arrow,
 * reflects the current fit. Each edge's arrow always points toward
 * what clicking it would do: an 'in' edge's arrow points outward
 * (click = go to out), an 'out' edge's arrow points inward (click =
 * go to in) — the opposite of the edge's current direction, since
 * it's showing the available action, not the current state (the
 * inner rect's shape is what shows current state). Arrows are always
 * the same neutral dark color; only their direction encodes state.
 *
 * Shared by two callers that both need the exact same interaction —
 * ui/toolbar.js's confirm-phase form (a pending, uncommitted edgeFit/
 * hinge, applied on Confirm) and ui/properties.js's edit panel for an
 * already-placed door (applied live, one click = one change) — so the
 * markup/geometry can't drift between "how you set it up" and "how
 * you change it later". Callers wire their own click handlers to the
 * `.door-edge-arrow` / `.door-hinge-swap` elements this returns;
 * rendering here is pure (no listeners attached).
 */

// Outer rect (the boundary opening) — fixed regardless of edge state.
const OUTER = { left: 25, right: 115, top: 10, bottom: 90 };
const INSET = 10; // how far an 'in' edge sits from the outer rect

// midpoint + outward unit vector for each of the outer rect's edges —
// arrows sit at these fixed boundary midpoints regardless of the
// inner rect's current (state-dependent) shape.
const EDGES = {
  top: { midX: 70, midY: OUTER.top, dx: 0, dy: -1 },
  bottom: { midX: 70, midY: OUTER.bottom, dx: 0, dy: 1 },
  left: { midX: OUTER.left, midY: 50, dx: -1, dy: 0 },
  right: { midX: OUTER.right, midY: 50, dx: 1, dy: 0 },
};

const ARROW_COLOR = '#3a3126';

export function renderDoorSchema(doorEdgeFit, doorHinge) {
  const fit = doorEdgeFit || {};
  const hinge = doorHinge === 'right' ? 'right' : 'left';
  const state = (edge) => (fit[edge] === 'out' ? 'out' : 'in');

  // Inner rect (the door panel) — each edge sits flush with the outer
  // rect when 'out', inset when 'in'.
  const innerLeft = state('left') === 'out' ? OUTER.left : OUTER.left + INSET;
  const innerRight = state('right') === 'out' ? OUTER.right : OUTER.right - INSET;
  const innerTop = state('top') === 'out' ? OUTER.top : OUTER.top + INSET;
  const innerBottom = state('bottom') === 'out' ? OUTER.bottom : OUTER.bottom - INSET;

  const arrows = Object.entries(EDGES).map(([edge, { midX, midY, dx, dy }]) => {
    const edgeState = state(edge);
    const innerPtX = midX - dx * 8, innerPtY = midY - dy * 8;
    const outerPtX = midX + dx * 8, outerPtY = midY + dy * 8;
    // Points toward the action, not the current state: 'in' -> arrow
    // points out (click to go out); 'out' -> arrow points in (click
    // to go in).
    const [x1, y1, x2, y2] = edgeState === 'in'
      ? [innerPtX, innerPtY, outerPtX, outerPtY]
      : [outerPtX, outerPtY, innerPtX, innerPtY];
    return `
      <g class="door-edge-arrow" data-edge="${edge}" style="cursor:pointer;">
        <title>${edge[0].toUpperCase()}${edge.slice(1)} edge: ${edgeState === 'out' ? 'out (overlay) — click to inset' : 'in (inset) — click to overlay'}</title>
        <circle cx="${midX}" cy="${midY}" r="13" fill="transparent" />
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ARROW_COLOR}" stroke-width="2.2" stroke-linecap="round" marker-end="url(#door-arrowhead)" />
      </g>
    `;
  }).join('');

  // Handle (solid) sits opposite the hinge; the dotted line — click to
  // swap hinge sides, which is also what swaps the two lines'
  // positions. Kept a fixed 12px in from the inner rect's current
  // left/right edge, whatever that edge's in/out state is.
  const handleX = hinge === 'left' ? innerRight - 12 : innerLeft + 12;
  const dottedX = hinge === 'left' ? innerLeft + 12 : innerRight - 12;
  const handleTop = innerTop + 10, handleBottom = innerBottom - 10;

  return `
    <svg viewBox="0 0 140 110" style="width:100%; max-width:220px; display:block; margin:8px auto;">
      <defs>
        <marker id="door-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="${ARROW_COLOR}" />
        </marker>
      </defs>

      <rect x="${OUTER.left}" y="${OUTER.top}" width="${OUTER.right - OUTER.left}" height="${OUTER.bottom - OUTER.top}" rx="2" fill="none" stroke="#3a3126" stroke-width="1.5" />
      <rect x="${innerLeft}" y="${innerTop}" width="${innerRight - innerLeft}" height="${innerBottom - innerTop}" rx="2" fill="none" stroke="#c9b998" stroke-width="1.2" />

      <line x1="${handleX}" y1="${handleTop}" x2="${handleX}" y2="${handleBottom}" stroke="#3a3126" stroke-width="3" stroke-linecap="round" />

      <g class="door-hinge-swap" style="cursor:pointer;">
        <title>Hinge is on the ${hinge} — click to swap sides</title>
        <rect x="${dottedX - 10}" y="${handleTop - 2}" width="20" height="${handleBottom - handleTop + 4}" fill="transparent" />
        <line x1="${dottedX}" y1="${handleTop}" x2="${dottedX}" y2="${handleBottom}" stroke="#a4977f" stroke-width="2" stroke-dasharray="3,3" />
      </g>

      ${arrows}
    </svg>
  `;
}

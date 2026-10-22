/**
 * ui/wallSchema.js
 *
 * Visual schema for a box's Front/Back wall edge fit — same frame
 * (outer rect = the box's outer boundary) / panel (inner rect, edges
 * dynamic per in/out state) / per-edge arrows as ui/doorSchema.js and
 * ui/drawerSchema.js, minus hinge/handle/dividers (a wall has none).
 * Arrows point toward the action (neutral dark): 'in' -> points out,
 * 'out' -> points in. Edges: left/right/top/bottom (vs the neighboring
 * walls). Own class `.wall-edge-arrow` so it never double-wires with
 * the door/drawer/plinth arrows. Rendering is pure (no listeners).
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

export function renderWallSchema(edgeFit) {
  const fit = edgeFit || {};
  const state = (edge) => (fit[edge] === 'out' ? 'out' : 'in');

  // Inner rect (the drawer stack's front panel) — each edge sits
  // flush with the outer rect when 'out', inset when 'in'.
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
      <g class="wall-edge-arrow" data-edge="${edge}" style="cursor:pointer;">
        <title>${edge[0].toUpperCase()}${edge.slice(1)} edge: ${edgeState === 'out' ? 'out (covers the neighboring wall) — click to inset' : 'in (inset) — click to cover'}</title>
        <circle cx="${midX}" cy="${midY}" r="13" fill="transparent" />
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ARROW_COLOR}" stroke-width="2.2" stroke-linecap="round" marker-end="url(#wall-arrowhead)" />
      </g>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 140 110" style="width:100%; max-width:220px; display:block; margin:8px auto;">
      <defs>
        <marker id="wall-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="${ARROW_COLOR}" />
        </marker>
      </defs>

      <rect x="${OUTER.left}" y="${OUTER.top}" width="${OUTER.right - OUTER.left}" height="${OUTER.bottom - OUTER.top}" rx="2" fill="none" stroke="#3a3126" stroke-width="1.5" />
      <rect x="${innerLeft}" y="${innerTop}" width="${innerRight - innerLeft}" height="${innerBottom - innerTop}" rx="2" fill="none" stroke="#c9b998" stroke-width="1.2" />

      ${arrows}
    </svg>
  `;
}

/**
 * ui/drawerSchema.js
 *
 * Visual drawer schema — same frame (outer rect, the boundary
 * opening) / front panel (inner rect, edges dynamic per in/out state)
 * / per-edge arrows as ui/doorSchema.js (a drawer front boundary fits
 * an opening exactly the same way a door does — see
 * features/drawer.js#DEFAULT_DRAWER_EDGE_FIT, the same shape/labels
 * as a door's edgeFit). See doorSchema.js's header for the full
 * reasoning on the inner rect tracking each edge's state and the
 * arrows always pointing toward the action (not the current state) in
 * a fixed neutral color. The one real difference (mirroring
 * tools/drawerTool.js's own "count field instead of hinge" note): no
 * hinge, so instead of a handle/dotted-line pair there are N-1
 * horizontal divider lines splitting the front into `count` drawers,
 * each with its own horizontal handle line — count itself stays a
 * plain number input next to this (see ui/toolbar.js's confirm form /
 * ui/properties.js's edit panel), not something this schema draws as
 * clickable.
 *
 * Kept as its own module (not merged into doorSchema.js) so each
 * schema stays independently readable — a small `EDGES`/`OUTER` table
 * is duplicated between the two files rather than shared, since it's
 * a few static coordinates, not logic that benefits from a single
 * source of truth.
 *
 * Shared by ui/toolbar.js's confirm-phase form (pending, uncommitted
 * edgeFit, applied on Confirm) and ui/properties.js's edit panel for
 * an already-placed drawer group (applied live, one click = one
 * change) — same reasoning as doorSchema.js. Callers wire their own
 * click handlers to the `.drawer-edge-arrow` elements this returns
 * (a distinct class from doorSchema.js's `.door-edge-arrow` — both
 * live in the same toolbar.js/properties.js wiring code, which
 * queries by class name regardless of which tool is actually active,
 * so a shared class would double-wire both handlers onto the same
 * elements); rendering here is pure (no listeners attached).
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

export function renderDrawerSchema(drawerEdgeFit, count) {
  const fit = drawerEdgeFit || {};
  const n = Math.max(1, Math.round(Number(count) || 1));
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
      <g class="drawer-edge-arrow" data-edge="${edge}" style="cursor:pointer;">
        <title>${edge[0].toUpperCase()}${edge.slice(1)} edge: ${edgeState === 'out' ? 'out (overlay) — click to inset' : 'in (inset) — click to overlay'}</title>
        <circle cx="${midX}" cy="${midY}" r="13" fill="transparent" />
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ARROW_COLOR}" stroke-width="2.2" stroke-linecap="round" marker-end="url(#drawer-arrowhead)" />
      </g>
    `;
  }).join('');

  // n equal drawers within the (now state-dependent) inner rect:
  // n-1 dividers + one horizontal handle centered in each.
  const segmentHeight = (innerBottom - innerTop) / n;

  const dividers = Array.from({ length: n - 1 }, (_, i) => {
    const y = innerTop + segmentHeight * (i + 1);
    return `<line x1="${innerLeft}" y1="${y}" x2="${innerRight}" y2="${y}" stroke="#c9b998" stroke-width="1.2" />`;
  }).join('');

  const handles = Array.from({ length: n }, (_, i) => {
    const y = innerTop + segmentHeight * (i + 0.5);
    return `<line x1="${innerLeft + 12}" y1="${y}" x2="${innerRight - 12}" y2="${y}" stroke="#3a3126" stroke-width="3" stroke-linecap="round" />`;
  }).join('');

  return `
    <svg viewBox="0 0 140 110" style="width:100%; max-width:220px; display:block; margin:8px auto;">
      <defs>
        <marker id="drawer-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="${ARROW_COLOR}" />
        </marker>
      </defs>

      <rect x="${OUTER.left}" y="${OUTER.top}" width="${OUTER.right - OUTER.left}" height="${OUTER.bottom - OUTER.top}" rx="2" fill="none" stroke="#3a3126" stroke-width="1.5" />
      <rect x="${innerLeft}" y="${innerTop}" width="${innerRight - innerLeft}" height="${innerBottom - innerTop}" rx="2" fill="none" stroke="#c9b998" stroke-width="1.2" />

      ${dividers}
      ${handles}
      ${arrows}
    </svg>
  `;
}

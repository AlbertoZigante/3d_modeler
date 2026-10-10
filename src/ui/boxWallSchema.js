/**
 * ui/boxWallSchema.js
 *
 * Visual edge-fit schema for a plain box wall (Front or Back — the
 * only panels features/box.js#relayoutBox reads an edgeFit off of).
 * Same frame (outer rect)/panel (inner rect, edges dynamic per in/out
 * state)/per-edge arrow logic as ui/doorSchema.js — see that file's
 * header comment for the full reasoning on the inner rect tracking
 * each edge's state and the arrows always pointing toward the action
 * (not the current state) in a fixed neutral color, not repeated
 * here. The one real difference: no handle/hinge — a box wall is just
 * a flat panel, nothing hinges on it — so this is the same schema
 * minus that one element. left/right/bottom/top are the same labels
 * a door's edgeFit uses (the Front/Back wall this edits is literally
 * what a door would otherwise replace), not plinth's left/right/back/
 * front plan-view labels.
 *
 * Kept as its own module rather than parameterizing doorSchema.js
 * with an optional hinge, consistent with drawerSchema.js's/
 * plinthSchema.js's own precedent of a dedicated file per edge-fit
 * shape rather than one schema with growing special cases.
 *
 * Used only by ui/properties.js's edgeFitSectionHTML (a box wall has
 * no confirm-phase form — Front/Back are created as part of the box
 * itself, never picked+confirmed the way a door/drawer/plinth is), so
 * every click here applies live, same as the other three schemas'
 * own post-creation edit panels. Callers wire their own click
 * handlers to the `.box-wall-edge-arrow` elements this returns (a
 * distinct class from the other schemas' arrows, same double-wiring
 * reason drawerSchema.js's header explains); rendering here is pure
 * (no listeners attached).
 */

// Outer rect (the boundary opening) — fixed regardless of edge state.
const OUTER = { left: 25, right: 115, top: 10, bottom: 90 };
const INSET = 10; // how far an 'in' edge sits from the outer rect

const EDGES = {
  top: { midX: 70, midY: OUTER.top, dx: 0, dy: -1 },
  bottom: { midX: 70, midY: OUTER.bottom, dx: 0, dy: 1 },
  left: { midX: OUTER.left, midY: 50, dx: -1, dy: 0 },
  right: { midX: OUTER.right, midY: 50, dx: 1, dy: 0 },
};

const ARROW_COLOR = '#3a3126';

export function renderBoxWallSchema(edgeFit) {
  const fit = edgeFit || {};
  const state = (edge) => (fit[edge] === 'out' ? 'out' : 'in');

  const innerLeft = state('left') === 'out' ? OUTER.left : OUTER.left + INSET;
  const innerRight = state('right') === 'out' ? OUTER.right : OUTER.right - INSET;
  const innerTop = state('top') === 'out' ? OUTER.top : OUTER.top + INSET;
  const innerBottom = state('bottom') === 'out' ? OUTER.bottom : OUTER.bottom - INSET;

  const arrows = Object.entries(EDGES).map(([edge, { midX, midY, dx, dy }]) => {
    const edgeState = state(edge);
    const innerPtX = midX - dx * 8, innerPtY = midY - dy * 8;
    const outerPtX = midX + dx * 8, outerPtY = midY + dy * 8;
    const [x1, y1, x2, y2] = edgeState === 'in'
      ? [innerPtX, innerPtY, outerPtX, outerPtY]
      : [outerPtX, outerPtY, innerPtX, innerPtY];
    const label = edge[0].toUpperCase() + edge.slice(1);
    return `
      <g class="box-wall-edge-arrow" data-edge="${edge}" style="cursor:pointer;">
        <title>${label} edge: ${edgeState === 'out' ? 'out (overlay) — click to inset' : 'in (inset) — click to overlay'}</title>
        <circle cx="${midX}" cy="${midY}" r="13" fill="transparent" />
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ARROW_COLOR}" stroke-width="2.2" stroke-linecap="round" marker-end="url(#box-wall-arrowhead)" />
      </g>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 140 110" style="width:100%; max-width:220px; display:block; margin:8px auto;">
      <defs>
        <marker id="box-wall-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="${ARROW_COLOR}" />
        </marker>
      </defs>

      <rect x="${OUTER.left}" y="${OUTER.top}" width="${OUTER.right - OUTER.left}" height="${OUTER.bottom - OUTER.top}" rx="2" fill="none" stroke="#3a3126" stroke-width="1.5" />
      <rect x="${innerLeft}" y="${innerTop}" width="${innerRight - innerLeft}" height="${innerBottom - innerTop}" rx="2" fill="none" stroke="#c9b998" stroke-width="1.2" />

      ${arrows}
    </svg>
  `;
}

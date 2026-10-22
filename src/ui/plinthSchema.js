/**
 * ui/plinthSchema.js
 *
 * Visual plinth schema — unlike doorSchema.js/drawerSchema.js (both a
 * front ELEVATION view), this is a top-down FOOTPRINT/plan view: the
 * outer rect is the owning box's Bottom panel footprint, the inner
 * rect is the plinth's own footprint, and the 4 edges are left/right/
 * back/front (features/plinth.js#PLINTH_EDGES), not left/right/top/
 * bottom. Same arrow-points-toward-the-action convention as the other
 * two schemas (always neutral dark, pointing out on an 'in' edge,
 * pointing in on an 'out' edge) and the same "inner rect edge sits
 * flush with the outer rect when 'out', inset when 'in'" shape logic
 * — see doorSchema.js's header comment for the full reasoning, not
 * repeated here.
 *
 * The one real difference from both other schemas: a plinth edge
 * isn't just in/out, it's in/out WITH A DISTANCE
 * (features/plinth.js#normalizePlinthEdgeFit's insetMm, kept even
 * while 'out' so toggling back restores it) — that distance is a
 * typed number, not something a click can set: the arrows toggle
 * in/out, and next to every edge that is 'in' this schema also renders
 * a number input (class `plinth-edge-inset`, data-edge) for the offset
 * in mm — strictly > 0, never 0 or negative. The inputs overlay the SVG
 * (absolute, positioned from the same viewBox coordinates).
 *
 * Shared by ui/toolbar.js... actually not — a plinth has no confirm-
 * phase form at all (tools/plinthTool.js places it immediately on
 * pick, same "no confirm step" as door/drawer's own creation flow),
 * so this is used ONLY by ui/properties.js's post-creation edit
 * panel. Kept as its own module anyway, consistent with doorSchema.js/
 * drawerSchema.js, and because a future confirm-phase form (if one's
 * ever added) should render identically to the edit panel, same
 * reasoning as those two. Callers wire their own click handlers to
 * the `.plinth-edge-arrow` elements this returns (a distinct class
 * from the other two schemas' arrows, for the same double-wiring
 * reason drawerSchema.js's own header explains); rendering here is
 * pure (no listeners attached).
 */

// Outer rect (the owning box's Bottom footprint) — fixed regardless
// of edge state.
const OUTER = { left: 55, right: 145, top: 30, bottom: 100 };
const INSET = 10; // fixed visual inset for an 'in' edge — schematic, not to scale with the real insetMm (same approach as doorSchema.js/drawerSchema.js)

// midpoint + outward unit vector for each outer edge. top/bottom here
// are back/front in plinth terms (a plan view: back = far side).
const EDGES = {
  back: { midX: 100, midY: OUTER.top, dx: 0, dy: -1 },
  front: { midX: 100, midY: OUTER.bottom, dx: 0, dy: 1 },
  left: { midX: OUTER.left, midY: 65, dx: -1, dy: 0 },
  right: { midX: OUTER.right, midY: 65, dx: 1, dy: 0 },
};

const VIEW_W = 200, VIEW_H = 135;
// Where each edge's offset input sits (viewBox units), just outside the arrow.
const INPUT_POS = {
  back: { x: 100, y: 9 },
  front: { x: 100, y: 124 },
  left: { x: 24, y: 65 },
  right: { x: 176, y: 65 },
};

const ARROW_COLOR = '#3a3126';

export function renderPlinthSchema(plinthEdgeFit) {
  const pct = (v, total) => `${(v / total * 100).toFixed(2)}%`;
  const fit = plinthEdgeFit || {};
  const state = (edge) => (fit[edge]?.fit === 'in' ? 'in' : 'out');

  // Inner rect (the plinth's own footprint) — each edge sits flush
  // with the outer rect when 'out', inset when 'in'.
  const innerLeft = state('left') === 'out' ? OUTER.left : OUTER.left + INSET;
  const innerRight = state('right') === 'out' ? OUTER.right : OUTER.right - INSET;
  const innerTop = state('back') === 'out' ? OUTER.top : OUTER.top + INSET;
  const innerBottom = state('front') === 'out' ? OUTER.bottom : OUTER.bottom - INSET;

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
    const label = edge[0].toUpperCase() + edge.slice(1);
    return `
      <g class="plinth-edge-arrow" data-edge="${edge}" style="cursor:pointer;">
        <title>${label} edge: ${edgeState === 'out' ? 'out (flush with the box) — click to inset' : 'in (inset) — click to go flush'}</title>
        <circle cx="${midX}" cy="${midY}" r="13" fill="transparent" />
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ARROW_COLOR}" stroke-width="2.2" stroke-linecap="round" marker-end="url(#plinth-arrowhead)" />
      </g>
    `;
  }).join('');

  const inputs = Object.keys(EDGES).filter((edge) => state(edge) === 'in').map((edge) => {
    const { x, y } = INPUT_POS[edge];
    const mm = Number(fit[edge]?.insetMm);
    const value = Number.isFinite(mm) && mm > 0 ? mm : 30;
    return `<input type="number" min="1" step="any" value="${value}" data-edge="${edge}" class="field-input plinth-edge-inset" title="${edge[0].toUpperCase()}${edge.slice(1)} offset (mm, must be > 0)" style="position:absolute; left:${pct(x, VIEW_W)}; top:${pct(y, VIEW_H)}; transform:translate(-50%,-50%); width:52px; padding:2px 4px; font-size:11px; text-align:center;" />`;
  }).join('');

  return `
    <div style="position:relative; width:100%; max-width:260px; margin:8px auto;">
    <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" style="width:100%; display:block;">
      <defs>
        <marker id="plinth-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="${ARROW_COLOR}" />
        </marker>
      </defs>

      <rect x="${OUTER.left}" y="${OUTER.top}" width="${OUTER.right - OUTER.left}" height="${OUTER.bottom - OUTER.top}" rx="2" fill="none" stroke="#3a3126" stroke-width="1.5" stroke-dasharray="2 2" />
      <rect x="${innerLeft}" y="${innerTop}" width="${innerRight - innerLeft}" height="${innerBottom - innerTop}" rx="2" fill="none" stroke="#c9b998" stroke-width="1.6" />

      ${arrows}
    </svg>
    ${inputs}
    </div>
  `;
}

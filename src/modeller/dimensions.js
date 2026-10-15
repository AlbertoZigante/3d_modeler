/**
 * modeller/dimensions.js
 *
 * Dimensions ("quotes") drawn in the viewport, in SCREEN SPACE: an SVG
 * layer over the canvas, so text, arrowheads and line widths are fixed CSS
 * pixels whatever the zoom, in the 3D and in the 2D view. Only the anchor
 * points come from the scene (re-projected through the camera each frame).
 *
 * Three kinds of dimension, told apart by colour:
 *
 *   grey   — a CANDIDATE: the instantaneous measured gap between two facing
 *            panels. Nothing is imposed; it only shows what the value is.
 *            Shown for the pair just picked with the Dimension tool, and for
 *            every neighbouring pair when the top-bar button is on "all".
 *   black  — a QUOTE imposed by the person (a `distance` constraint, or a
 *            box resize applied from two walls). Red if it is in conflict.
 *   blue   — the dimension currently being EDITED.
 *
 * Interaction (no extra menus or buttons):
 *   - click its LABEL       -> the text turns blue and becomes editable in
 *                              place; Enter confirms (a grey one becomes an
 *                              imposed black one), Esc/click-away cancels;
 *                              Enter on an EMPTY field removes an imposed one
 *   - click its LINE        -> selects it (drawn thick and blue); Esc then
 *                              DELETES it (an imposed quote is removed; a grey
 *                              one is dismissed for the session)
 *   - drag a dimension      -> slides the line along its perpendicular
 *                              direction, out of the way of the object
 *                              (stored as `dimOffsetMm` for imposed quotes)
 *
 * Pure, DOM-free (unit-tested): computeDimensionSpecs, computeCandidateSpecs,
 * candidateSpecForPair, specGeometry, projectSpec, dragToOffsetMm.
 * createDimensionOverlay is the only DOM-touching export.
 */
import * as THREE from 'three';
import {
  MM_TO_UNIT,
  FIELD_TO_AXIS,
  FACE_TO_DIM_FIELD,
  LOCAL_FACES,
  getAlignedAxis,
  isSystemManaged,
  computeWorldHalfExtents,
  getDisplayName,
} from './modules.js';

const AXES = ['x', 'y', 'z'];
// Axis the dimension line slides along: the in-plane direction
// perpendicular to the quoted axis (front elevation: x for a vertical
// quote, y for a horizontal one; depth quotes also use x).
const PERP_AXIS = { x: 'y', y: 'x', z: 'x' };
const AUTO_MARGIN_MM = 60;   // default clearance outside the two panels
const FRONT_OFFSET_MM = 12;  // keeps X/Y lines in front of the panels in the front elevation
const EXT_GAP_MM = 3;        // extension lines start this far from the panel edge
const MIN_CANDIDATE_GAP_MM = 0.5;
const MIN_OVERLAP_MM = 1;
const MAX_CANDIDATES = 80;

// Fixed on-screen sizes (CSS px) — never scaled by zoom.
export const FONT_PX = 12;
export const ARROW_PX = 8;
export const LINE_PX = 1.5;
export const COLORS = { imposed: '#111111', candidate: '#8a8a8a', editing: '#1d4ed8', conflict: '#dc2626' };

// ---------------------------------------------------------------
// Pure geometry (mm)
// ---------------------------------------------------------------

/**
 * Line + extension-line endpoints (mm) for a spec at a given extra
 * shift `offsetMm` of the dimension line along its perpendicular axis.
 * @returns {{from:{x,y,z}, to:{x,y,z}, ext:Array<[{x,y,z},{x,y,z}]>}}
 */
export function specGeometry(spec, offsetMm = spec.offsetMm) {
  const { axis, perp, at, anchorMm, myMm, ends } = spec;
  const linePerp = spec.autoPerpMm + offsetMm;
  const from = { ...at, [axis]: anchorMm, [perp]: linePerp };
  const to = { ...at, [axis]: myMm, [perp]: linePerp };
  const ext = [];
  ends.forEach((end) => {
    // Extension line from the panel's edge (on the side the line was moved to) out to the dimension line.
    let start = null;
    if (linePerp >= end.pos + end.half) start = end.pos + end.half + EXT_GAP_MM;
    else if (linePerp <= end.pos - end.half) start = end.pos - end.half - EXT_GAP_MM;
    if (start === null || Math.abs(linePerp - start) < 1) return;
    ext.push([
      { ...at, [axis]: end.faceMm, [perp]: start },
      { ...at, [axis]: end.faceMm, [perp]: linePerp },
    ]);
  });
  return { from, to, ext };
}

// Shared by every kind of spec: where the line sits and what it connects.
function buildSpec({ a, d, axis, anchorMm, myMm, offsetMm, extra }) {
  const ha = computeWorldHalfExtents(a);
  const hd = computeWorldHalfExtents(d);
  const perp = PERP_AXIS[axis];
  const at = {};
  AXES.filter((k) => k !== axis && k !== perp).forEach((k) => {
    const lo = Math.max(a.position[k] - ha[k], d.position[k] - hd[k]);
    const hi = Math.min(a.position[k] + ha[k], d.position[k] + hd[k]);
    at[k] = (lo + hi) / 2; // overlap centre, or the middle of the gap if they don't overlap
  });
  // Along X/Y quotes the line sits just in FRONT of both panels so it is
  // visible in the front elevation instead of hidden inside them.
  if (axis !== 'z') at.z = Math.max(a.position.z + ha.z, d.position.z + hd.z) + FRONT_OFFSET_MM;
  // Default position: just outside the two panels, so a fresh dimension
  // doesn't sit on top of the object. The person's own shift is added to it.
  const autoPerpMm = Math.max(a.position[perp] + ha[perp], d.position[perp] + hd[perp]) + AUTO_MARGIN_MM;
  const spec = {
    axis, perp, at, anchorMm, myMm, autoPerpMm,
    ends: [
      { pos: a.position[perp], half: ha[perp], faceMm: anchorMm },
      { pos: d.position[perp], half: hd[perp], faceMm: myMm },
    ],
    offsetMm: Number.isFinite(offsetMm) ? offsetMm : 0,
    ...extra,
  };
  Object.assign(spec, specGeometry(spec));
  return spec;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * IMPOSED dimensions: one spec per active quote (non-overridden `distance`
 * constraint). All positions in mm.
 */
export function computeDimensionSpecs(rawPanels, resolvedPanels) {
  const resolved = new Map(resolvedPanels.map((r) => [r.id, r]));
  const specs = [];
  rawPanels.forEach((raw) => {
    (raw.constraints || []).forEach((c) => {
      if (c.type !== 'distance' || c.overridden) return;
      const d = resolved.get(raw.id);
      const a = resolved.get(c.from?.node);
      if (!d || !a || d.hidden || a.hidden) return;
      const axis = FIELD_TO_AXIS[c.field];
      const aAl = getAlignedAxis(a.rotation, c.from.face);
      const mAl = getAlignedAxis(d.rotation, c.myFace);
      if (!axis || !aAl || !mAl || aAl.axis !== axis || mAl.axis !== axis) return;
      const anchorMm = a.position[axis] + aAl.sign * (a[FACE_TO_DIM_FIELD[c.from.face]] / 2);
      const myMm = d.position[axis] + mAl.sign * (d[FACE_TO_DIM_FIELD[c.myFace]] / 2);
      const actualMm = (myMm - anchorMm) * aAl.sign;
      specs.push(buildSpec({
        a, d, axis, anchorMm, myMm, offsetMm: c.dimOffsetMm,
        extra: {
          kind: 'imposed',
          id: c.id, constraintId: c.id, drivenId: raw.id, anchorId: a.id,
          valueMm: c.value, actualMm,
          ok: Math.abs(actualMm - c.value) < 0.5,
          label: `${round1(c.value)} mm`,
          title: `${getDisplayName(raw)} ↔ ${getDisplayName(a)}`,
        },
      }));
    });
  });
  return specs;
}

// The local face of a resolved panel that looks toward +sign (or -sign) along an axis.
function faceToward(r, axis, sign) {
  return Object.keys(LOCAL_FACES).find((f) => {
    const al = getAlignedAxis(r.rotation, f);
    return al && al.axis === axis && al.sign === sign;
  }) || null;
}

/**
 * CANDIDATE dimension for one pair of panels along `axis`: `lower` is the
 * panel on the negative side, `upper` on the positive side. Pure measurement —
 * nothing is imposed. Returns null if either panel has no face on that axis.
 */
function candidateSpec(lower, upper, axis, offsets) {
  const faceA = faceToward(lower, axis, +1);
  const faceB = faceToward(upper, axis, -1);
  if (!faceA || !faceB) return null;
  const hl = computeWorldHalfExtents(lower);
  const hu = computeWorldHalfExtents(upper);
  const anchorMm = lower.position[axis] + hl[axis];
  const myMm = upper.position[axis] - hu[axis];
  const gap = myMm - anchorMm;
  const id = `cand:${lower.id}|${upper.id}|${axis}`;
  return buildSpec({
    a: lower, d: upper, axis, anchorMm, myMm, offsetMm: offsets?.get(id),
    extra: {
      kind: 'candidate', id,
      faceA: { nodeId: lower.id, faceName: faceA },
      faceB: { nodeId: upper.id, faceName: faceB },
      drivenId: null, anchorId: lower.id,
      valueMm: round1(gap), actualMm: gap, ok: true,
      label: `${round1(gap)} mm`,
      title: `${getDisplayName(lower)} ↔ ${getDisplayName(upper)}`,
    },
  });
}

/**
 * Candidate for two FACES the person just picked (already resolved to facing
 * faces, see engine/quotes.js#resolveFacingFaces). null if they aren't a measurable pair.
 */
export function candidateSpecForPair(resolvedPanels, a, b, offsets) {
  const byId = new Map(resolvedPanels.map((r) => [r.id, r]));
  const ra = byId.get(a.nodeId);
  const rb = byId.get(b.nodeId);
  if (!ra || !rb) return null;
  const al = getAlignedAxis(ra.rotation, a.faceName);
  if (!al) return null;
  const axis = al.axis;
  // `a` looks toward +sign: it is the lower panel when sign is +1.
  const [lower, upper] = al.sign > 0 ? [ra, rb] : [rb, ra];
  return candidateSpec(lower, upper, axis, offsets);
}

const pairKey = (a, b, axis) => `${[a, b].sort().join('|')}|${axis}`;

/**
 * Candidates for the whole design: for every eligible panel, the nearest
 * facing neighbour on each axis (plus, for box walls, the opposite wall —
 * the box's interior width/height/depth). "Eligible" = panels a person can
 * dimension: user-owned panels and box walls (plinth, doors, drawers and
 * legs are system-managed and left out).
 * Pairs already covered by an imposed quote are skipped.
 */
export function computeCandidateSpecs(rawPanels, resolvedPanels, imposedSpecs = [], offsets) {
  // Geometry comes from the resolved panels; ownership / box-wall flags only exist on the raw nodes.
  const rawById = new Map(rawPanels.map((p) => [p.id, p]));
  const flags = (r) => rawById.get(r.id) || {};
  const list = resolvedPanels.filter((r) => !r.hidden && (!isSystemManaged(flags(r)) || flags(r).isBoxWall));
  const half = new Map(list.map((r) => [r.id, computeWorldHalfExtents(r)]));
  const covered = new Set(imposedSpecs.map((s) => pairKey(s.drivenId, s.anchorId, s.axis)));
  const found = new Map();

  const overlaps = (A, B, axis) => AXES.filter((k) => k !== axis).every((k) => {
    const lo = Math.max(A.position[k] - half.get(A.id)[k], B.position[k] - half.get(B.id)[k]);
    const hi = Math.min(A.position[k] + half.get(A.id)[k], B.position[k] + half.get(B.id)[k]);
    return hi - lo > MIN_OVERLAP_MM;
  });
  const nearestAbove = (A, universe, axis) => {
    let best = null;
    universe.forEach((B) => {
      if (B.id === A.id) return;
      const gap = (B.position[axis] - half.get(B.id)[axis]) - (A.position[axis] + half.get(A.id)[axis]);
      if (gap < MIN_CANDIDATE_GAP_MM || !overlaps(A, B, axis)) return;
      if (!best || gap < best.gap) best = { B, gap };
    });
    return best;
  };
  const add = (A, B, axis) => {
    const key = pairKey(A.id, B.id, axis);
    if (found.has(key) || covered.has(key)) return;
    const spec = candidateSpec(A, B, axis, offsets);
    if (spec) found.set(key, spec);
  };

  AXES.forEach((axis) => {
    // 1. nearest neighbour of every panel (box-wall pairs of one box are pass 2)
    list.forEach((A) => {
      const universe = list.filter((B) => !(flags(A).isBoxWall && flags(B).isBoxWall && A.groupId && A.groupId === B.groupId));
      const best = nearestAbove(A, universe, axis);
      if (best) add(A, best.B, axis);
    });
    // 2. interior size of each box: nearest wall of the same box
    const byGroup = new Map();
    list.filter((r) => flags(r).isBoxWall && r.groupId).forEach((r) => {
      if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, []);
      byGroup.get(r.groupId).push(r);
    });
    byGroup.forEach((walls) => walls.forEach((A) => {
      const best = nearestAbove(A, walls, axis);
      if (best) add(A, best.B, axis);
    }));
  });
  return [...found.values()].slice(0, MAX_CANDIDATES);
}

const toVec = (p) => new THREE.Vector3(p.x * MM_TO_UNIT, p.y * MM_TO_UNIT, p.z * MM_TO_UNIT);

function toScreen(p, camera, w, h) {
  const v = toVec(p).project(camera);
  return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, behind: v.z > 1 || v.z < -1 };
}

/**
 * Screen-space (px) layout of a spec for a camera: line ends, extension
 * lines, and `axisVec` — the screen vector (px) of 100 mm along the
 * perpendicular axis at the line's midpoint, used to turn a mouse drag
 * into millimetres.
 */
export function projectSpec(spec, camera, w, h, offsetMm = spec.offsetMm) {
  const g = specGeometry(spec, offsetMm);
  const p1 = toScreen(g.from, camera, w, h);
  const p2 = toScreen(g.to, camera, w, h);
  const ext = g.ext.map(([s, e]) => [toScreen(s, camera, w, h), toScreen(e, camera, w, h)]);
  const mid = { x: (g.from.x + g.to.x) / 2, y: (g.from.y + g.to.y) / 2, z: (g.from.z + g.to.z) / 2 };
  const a = toScreen(mid, camera, w, h);
  const b = toScreen({ ...mid, [spec.perp]: mid[spec.perp] + 100 }, camera, w, h);
  return { p1, p2, ext, axisVec: { x: b.x - a.x, y: b.y - a.y }, behind: p1.behind || p2.behind };
}

/**
 * Mouse drag (px) -> shift (mm) of the dimension line along its
 * perpendicular axis, so the line follows the cursor at any zoom.
 */
export function dragToOffsetMm(deltaPx, axisVecPx, unitMm = 100) {
  const len2 = axisVecPx.x * axisVecPx.x + axisVecPx.y * axisVecPx.y;
  if (len2 < 1e-6) return 0; // axis points along the view direction — can't be dragged from here
  return ((deltaPx.x * axisVecPx.x + deltaPx.y * axisVecPx.y) / len2) * unitMm;
}

// ---------------------------------------------------------------
// DOM overlay
// ---------------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
};

/**
 * @param {HTMLElement} host - the viewport container (must be positioned)
 * @param {{onEditValue?:(spec, mm:number)=>boolean|void,
 *          onRemove?:(spec)=>void,
 *          onMove?:(spec, offsetMm:number)=>void}} handlers
 *   `spec.kind` is "imposed" or "candidate". A candidate's dragged position
 *   lives in the overlay (nothing is stored until it is imposed).
 */
export function createDimensionOverlay(host, handlers = {}) {
  const svg = svgEl('svg', { class: 'quote-overlay' });
  Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: '4' });
  host.appendChild(svg);

  // The only editing UI: a plain text field drawn over the label.
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.className = 'quote-inline-input';
  Object.assign(input.style, {
    position: 'absolute', display: 'none', zIndex: '6', boxSizing: 'border-box', textAlign: 'center',
    font: `700 ${FONT_PX}px sans-serif`, color: COLORS.editing, background: 'rgba(255,255,255,0.97)',
    border: `1.5px solid ${COLORS.editing}`, borderRadius: '4px', outline: 'none', padding: '0 4px', height: `${FONT_PX + 10}px`,
  });
  host.appendChild(input);

  let items = [];            // { spec, g, parts, live, layout, layoutPx }
  let interactive = true;
  let lastView = null;       // { camera, w, h }
  let editingId = null;
  let selectedId = null;               // a dimension selected by clicking its line (Esc deletes it)
  const dismissed = new Set();         // grey candidates the person deleted this session
  const candidateOffsets = new Map(); // candidate id -> dragged offset (mm), session only
  let model = { raw: [], resolved: [], conflicted: new Set(), mode: 'user', pendingPair: null };

  const colorOf = (item) => {
    if (item.spec.id === editingId || item.spec.id === selectedId) return COLORS.editing;
    if (item.spec.kind === 'candidate') return COLORS.candidate;
    return item.conflicted || !item.spec.ok ? COLORS.conflict : COLORS.imposed;
  };
  function paint(item) {
    const color = colorOf(item);
    const { parts } = item;
    parts.line.setAttribute('stroke', color);
    parts.line.setAttribute('stroke-width', item.spec.id === selectedId ? LINE_PX * 2 : LINE_PX);
    parts.arrows.forEach((a) => a.setAttribute('fill', color));
    parts.ext.forEach((l) => l.setAttribute('stroke', color));
    parts.rect.setAttribute('stroke', color);
    parts.text.setAttribute('fill', color);
    parts.text.style.display = item.spec.id === editingId ? 'none' : '';
  }

  function stopEditing() {
    editingId = null;
    input.style.display = 'none';
    input.style.borderColor = COLORS.editing;
    items.forEach(paint);
  }
  function startEditing(item) {
    editingId = item.spec.id;
    input.value = String(item.spec.valueMm);
    input.style.borderColor = COLORS.editing;
    input.style.display = 'block';
    items.forEach(paint);
    placeInput(item);
    input.focus();
    input.select();
  }
  function placeInput(item) {
    if (!item?.layoutPx) return;
    const w = Math.max(72, item.layoutPx.w);
    input.style.width = `${w}px`;
    input.style.left = `${item.layoutPx.x - w / 2}px`;
    input.style.top = `${item.layoutPx.y - (FONT_PX + 10) / 2}px`;
  }
  function currentItem() {
    return items.find((i) => i.spec.id === editingId) || null;
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // Esc here must not also cancel the Dimension tool
    const item = currentItem();
    if (!item) return;
    if (e.key === 'Escape') { e.preventDefault(); stopEditing(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = input.value.trim().replace(',', '.');
    if (raw === '') { // empty + Enter removes an imposed dimension
      if (item.spec.kind === 'imposed') { const spec = item.spec; stopEditing(); handlers.onRemove?.(spec); } else stopEditing();
      return;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) { input.style.borderColor = COLORS.conflict; return; }
    const ok = handlers.onEditValue?.(item.spec, v);
    if (ok === false) input.style.borderColor = COLORS.conflict; // refused: stay open, the reason is in the toast
    else stopEditing();
  });
  input.addEventListener('blur', () => { if (editingId) stopEditing(); });

  function select(id) {
    selectedId = id;
    items.forEach(paint);
  }
  // Click anywhere that is not a dimension: deselect. (Capture phase, so it
  // runs before the canvas / other tools handle the same click.)
  const onWindowPointerDown = (e) => {
    if (selectedId && !(e.target && svg.contains(e.target))) select(null);
  };
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  // Esc on a selected dimension deletes it. Capture + stopPropagation so the
  // app's own Esc handling (cancel the Dimension tool...) does not also fire.
  const onWindowKeyDown = (e) => {
    if (e.key !== 'Escape' || !selectedId || editingId) return;
    const item = items.find((i) => i.spec.id === selectedId);
    if (!item) { selectedId = null; return; }
    e.preventDefault();
    e.stopPropagation();
    const spec = item.spec;
    selectedId = null;
    if (spec.kind === 'candidate') {
      dismissed.add(spec.id);
      update(model.raw, model.resolved, model.conflicted, model);
    } else {
      handlers.onRemove?.(spec);
    }
  };
  window.addEventListener('keydown', onWindowKeyDown, true);

  function beginInteraction(item, e, isLabel) {
    if (!interactive || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startOffset = item.spec.offsetMm;
    const axisVec = item.layout?.axisVec || { x: 0, y: 0 };
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
      moved = true;
      item.live = startOffset + dragToOffsetMm({ x: dx, y: dy }, axisVec, 100);
      refresh();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) {
        const final = round1(item.live);
        item.live = null;
        if (item.spec.kind === 'candidate') {
          candidateOffsets.set(item.spec.id, final);
          update(model.raw, model.resolved, model.conflicted, model);
        } else {
          handlers.onMove?.(item.spec, final);
        }
      } else if (isLabel) {
        select(null);
        startEditing(item);
      } else {
        select(item.spec.id); // clicked the line: select it (Esc deletes)
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function build(spec, conflicted) {
    const g = svgEl('g');
    const parts = {
      ext: [svgEl('line'), svgEl('line')],
      hit: svgEl('line', { stroke: 'transparent', 'stroke-width': 14, style: 'pointer-events:stroke;cursor:grab' }),
      line: svgEl('line', { 'stroke-width': LINE_PX }),
      arrows: [svgEl('path'), svgEl('path')],
      label: svgEl('g', { style: 'cursor:text;pointer-events:all' }),
    };
    parts.ext.forEach((l) => { l.setAttribute('stroke-width', 1); l.setAttribute('stroke-dasharray', '3 3'); l.setAttribute('opacity', '0.8'); g.appendChild(l); });
    g.append(parts.hit, parts.line, ...parts.arrows);
    parts.rect = svgEl('rect', { rx: 4, ry: 4, fill: 'rgba(255,255,255,0.94)', 'stroke-width': 1.2 });
    parts.text = svgEl('text', { 'font-size': FONT_PX, 'font-family': 'sans-serif', 'font-weight': 700, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    parts.text.textContent = spec.label;
    const title = svgEl('title');
    title.textContent = spec.kind === 'candidate'
      ? `${spec.title} — measured, not imposed. Click the value to type one and impose it (click the line then Esc to dismiss).`
      : `${spec.title} — click the value to edit · click the line then Esc to delete · drag to move`;
    parts.label.append(title, parts.rect, parts.text);
    g.appendChild(parts.label);
    svg.appendChild(g);
    const item = { spec, g, parts, conflicted, live: null, layout: null, layoutPx: null };
    parts.hit.addEventListener('pointerdown', (e) => beginInteraction(item, e, false));
    parts.label.addEventListener('pointerdown', (e) => beginInteraction(item, e, true));
    paint(item);
    return item;
  }

  function arrowPath(tip, dir) {
    const bx = tip.x - dir.x * ARROW_PX;
    const by = tip.y - dir.y * ARROW_PX;
    const nx = -dir.y * (ARROW_PX / 3);
    const ny = dir.x * (ARROW_PX / 3);
    return `M${tip.x},${tip.y} L${bx + nx},${by + ny} L${bx - nx},${by - ny} Z`;
  }

  function refresh(camera, w, h) {
    if (camera) lastView = { camera, w, h };
    if (!lastView) return;
    const { camera: cam, w: vw, h: vh } = lastView;
    items.forEach((item) => {
      const L = projectSpec(item.spec, cam, vw, vh, item.live ?? item.spec.offsetMm);
      item.layout = L;
      const { parts } = item;
      if (L.behind) { item.g.style.display = 'none'; return; }
      item.g.style.display = '';
      const set = (el, a) => Object.entries(a).forEach(([k, v]) => el.setAttribute(k, v));
      set(parts.line, { x1: L.p1.x, y1: L.p1.y, x2: L.p2.x, y2: L.p2.y });
      set(parts.hit, { x1: L.p1.x, y1: L.p1.y, x2: L.p2.x, y2: L.p2.y });
      parts.ext.forEach((el, i) => {
        const seg = L.ext[i];
        el.style.display = seg ? '' : 'none';
        if (seg) set(el, { x1: seg[0].x, y1: seg[0].y, x2: seg[1].x, y2: seg[1].y });
      });
      const dx = L.p2.x - L.p1.x;
      const dy = L.p2.y - L.p1.y;
      const len = Math.hypot(dx, dy);
      const dir = len > 0.5 ? { x: dx / len, y: dy / len } : { x: 0, y: -1 };
      const inward = len > ARROW_PX * 2.4; // too short to hold the arrows between the faces -> point outward
      parts.arrows[0].setAttribute('d', arrowPath(L.p1, inward ? { x: -dir.x, y: -dir.y } : dir));
      parts.arrows[1].setAttribute('d', arrowPath(L.p2, inward ? dir : { x: -dir.x, y: -dir.y }));
      const mx = (L.p1.x + L.p2.x) / 2;
      const my = (L.p1.y + L.p2.y) / 2;
      let nx = -dir.y;
      let ny = dir.x;
      if (ny > 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; } // keep the label above/left of the line
      const lw = item.spec.label.length * (FONT_PX * 0.62) + 14;
      const lh = FONT_PX + 8;
      const off = len > 0.5 ? 13 + lh / 2 : 0;
      const cx = mx + nx * off;
      const cy = my + ny * off;
      set(parts.rect, { x: cx - lw / 2, y: cy - lh / 2, width: lw, height: lh });
      set(parts.text, { x: cx, y: cy });
      item.layoutPx = { x: cx, y: cy, w: lw };
      if (item.spec.id === editingId) placeInput(item);
    });
  }

  /**
   * @param {Array} rawPanels
   * @param {Array} resolvedPanels
   * @param {Set<string>} conflictedIds - quoted panels in conflict (drawn red)
   * @param {{mode?: 'off'|'user'|'all', pendingPair?: {a, b}|null}} [opts]
   *   mode: off = only the pair being dimensioned; user = imposed quotes;
   *   all = imposed + a grey candidate for every neighbouring pair.
   */
  function update(rawPanels, resolvedPanels, conflictedIds = new Set(), opts = {}) {
    const nextMode = opts.mode ?? model.mode;
    if (nextMode !== model.mode) dismissed.clear(); // changing the Quotes mode brings everything back
    model = { raw: rawPanels, resolved: resolvedPanels, conflicted: conflictedIds, mode: nextMode, pendingPair: opts.pendingPair ?? null };
    const imposed = computeDimensionSpecs(rawPanels, resolvedPanels);
    const shown = [];
    if (model.mode !== 'off') shown.push(...imposed);
    if (model.mode === 'all') shown.push(...computeCandidateSpecs(rawPanels, resolvedPanels, imposed, candidateOffsets).filter((c) => !dismissed.has(c.id)));
    if (model.pendingPair) {
      const spec = candidateSpecForPair(resolvedPanels, model.pendingPair.a, model.pendingPair.b, candidateOffsets);
      if (spec) {
        // A pair can only be dimensioned once: if it already has an imposed
        // dimension, show THAT one (even when the mode hides imposed ones),
        // not a second, grey one on top of it.
        const existing = imposed.find((q) => pairKey(q.drivenId, q.anchorId, q.axis) === pairKey(spec.faceA.nodeId, spec.faceB.nodeId, spec.axis));
        const target = existing || spec;
        if (!shown.some((x) => x.id === target.id)) shown.push(target);
      }
    }
    svg.replaceChildren();
    items = shown.map((spec) => build(spec, spec.kind === 'imposed' && conflictedIds.has(spec.drivenId)));
    if (editingId && !items.some((i) => i.spec.id === editingId)) stopEditing();
    if (selectedId && !items.some((i) => i.spec.id === selectedId)) selectedId = null;
    refresh();
  }

  return {
    update,
    refresh,
    setInteractive(v) { interactive = !!v; svg.classList.toggle('quote-overlay-passive', !interactive); },
    dispose() {
      stopEditing();
      selectedId = null;
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      window.removeEventListener('keydown', onWindowKeyDown, true);
      svg.remove();
      input.remove();
    },
  };
}

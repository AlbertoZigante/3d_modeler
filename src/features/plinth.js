/**
 * features/plinth.js
 *
 * PLINTH — a 4-panel (left/right/back/front) open frame built directly
 * underneath an existing box's own Bottom panel, flush with its real
 * footprint. Unlike features/door.js/drawer.js, there's no boundary-
 * pick step: a plinth has exactly one input — which box's Bottom to
 * sit under — and that's just "the currently selected group" (see
 * tools/plinth.js's own empty state for why no pick-mode tool file
 * exists at all, same as features/box.js's addBox() needing none).
 * No Top/Bottom caps of its own: a plinth is a kick-base, open top
 * (where the carcass's own Bottom rests on it) and open bottom (on the
 * floor) — exactly what "4 lateral panels" means.
 *
 * CORNERS: Back/Front run the FULL plinth width ('out' past the
 * lateral panels); Left/Right sit between them (depth - 2T). The
 * footprint itself is the owning Bottom panel's x/z size, each edge
 * optionally pulled in (see normalizePlinthEdgeFit).
 */
import { createPanelNode, MIN_PANEL_DIM_MM, computeWorldHalfExtents } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';
import { VERTICAL_ROTATION, PARALLEL_ROTATION } from '../shared/geometry.js';
import { findBoxSibling } from './box.js';

export const DEFAULT_PLINTH_HEIGHT_MM = 60;
export const DEFAULT_PLINTH_INSET_MM = 30; // used when an edge is switched to 'in' and no mm was typed yet
export const PLINTH_EDGES = ['left', 'right', 'back', 'front'];
// Reinforcement panels: clear spacing between adjacent panels (faces,
// outer plinth walls included) is kept within this range, in mm.
export const MIN_RIB_SPACING_MM = 250;
export const MAX_RIB_SPACING_MM = 400;
const PERIMETER_ROLES = PLINTH_EDGES;

/**
 * How many evenly spaced ribs of thickness T fit in a clear span L so
 * every gap lies in [MIN_RIB_SPACING_MM, MAX_RIB_SPACING_MM]. Fewest
 * ribs that work wins; when no count can satisfy the range (e.g. a
 * 410 mm span), the count whose gap is closest to the range wins.
 * @returns {{count:number, gap:number}}
 */
export function computeRibLayout(L, T) {
  let best = null;
  for (let n = 0; n <= 60; n++) {
    const gap = (L - n * T) / (n + 1);
    if (gap <= 0) break;
    const dev = gap > MAX_RIB_SPACING_MM ? gap - MAX_RIB_SPACING_MM : gap < MIN_RIB_SPACING_MM ? MIN_RIB_SPACING_MM - gap : 0;
    if (dev === 0) return { count: n, gap };
    if (!best || dev < best.dev) best = { count: n, gap, dev };
  }
  return best ? { count: best.count, gap: best.gap } : { count: 0, gap: L };
}

/**
 * Per-edge fit of the plinth against the Bottom panel's footprint.
 * 'out' = flush with that outer
 * edge; 'in' = set back from it by insetMm. insetMm is kept even
 * while 'out' so toggling back restores the last typed value.
 *
 * @returns {{left,right,back,front: {fit:'in'|'out', insetMm:number}}}
 */
export function normalizePlinthEdgeFit(edgeFit) {
  const out = {};
  PLINTH_EDGES.forEach((edge) => {
    const e = edgeFit?.[edge] || {};
    const insetMm = Number.isFinite(e.insetMm) ? Math.max(0, e.insetMm) : DEFAULT_PLINTH_INSET_MM;
    out[edge] = { fit: e.fit === 'in' ? 'in' : 'out', insetMm };
  });
  return out;
}

/**
 * x/z footprint (mm) of the box's own Bottom panel — the plinth's
 * reference. Doors/drawer fronts that overhang ('out') the Bottom are
 * deliberately ignored, otherwise the plinth would grow under them.
 */
function computeBottomFootprint(bottom) {
  const h = computeWorldHalfExtents(bottom);
  return { xMin: bottom.position.x - h.x, xMax: bottom.position.x + h.x, zMin: bottom.position.z - h.z, zMax: bottom.position.z + h.z };
}
// No feature-specific floor beyond the general one — unlike
// features/drawer.js's top/bottom margins, there's no carcass-
// clearance reason to demand more than "still a real panel".
export const MIN_PLINTH_HEIGHT_MM = MIN_PANEL_DIM_MM;

/**
 * Pure placement math — resolves the owning box's Bottom panel fresh
 * every call (never trusts a stale caller-held copy), so this is safe
 * to call both at creation time and on every later height edit.
 *
 * @param {Array} panels - raw graph
 * @param {string} groupId - the box whose Bottom panel to build under
 * @param {{material?:string, thicknessMm?:number, heightMm?:number}} spec
 * @returns {{ok:true, groupId, material, thicknessMm, heightMm,
 *   left:{center,rotation,dims}, right:{...}, back:{...}, front:{...}}
 *   | {ok:false, reason:'no-bottom-panel'|'panel-too-short'}}
 */
export function computePlinthPlacement(panels, groupId, spec = {}) {
  const bottomRaw = findBoxSibling(panels, groupId, 'Bottom');
  if (!bottomRaw) return { ok: false, reason: 'no-bottom-panel' };

  const resolved = resolveConstraints(panels);
  const bottom = resolved.find((r) => r.id === bottomRaw.id);
  if (!bottom) return { ok: false, reason: 'no-bottom-panel' };

  const material = spec.material ?? bottomRaw.material;
  const thicknessMm = spec.thicknessMm ?? bottom.thickness;
  const heightMm = Math.max(MIN_PLINTH_HEIGHT_MM, spec.heightMm ?? DEFAULT_PLINTH_HEIGHT_MM);

  // Footprint = the Bottom panel's own x/z size,
  // each edge pulled in by its own 'in' inset (0 when 'out').
  const edgeFit = normalizePlinthEdgeFit(spec.edgeFit);
  const outer = computeBottomFootprint(bottom);
  const inset = (edge) => (edgeFit[edge].fit === 'in' ? edgeFit[edge].insetMm : 0);
  const xMin = outer.xMin + inset('left'), xMax = outer.xMax - inset('right');
  const zMin = outer.zMin + inset('back'), zMax = outer.zMax - inset('front');
  const W = xMax - xMin;
  const D = zMax - zMin;
  const cx = (xMin + xMax) / 2, cz = (zMin + zMax) / 2;
  const T = thicknessMm;

  if (W < MIN_PANEL_DIM_MM || (D - 2 * T) < MIN_PANEL_DIM_MM || heightMm < MIN_PANEL_DIM_MM) {
    return { ok: false, reason: 'panel-too-short' };
  }

  const topY = bottom.position.y - bottom.thickness / 2; // Bottom's own underside — the plinth's real top edge, flush
  const centerY = topY - heightMm / 2;

  // Corner ownership: Back/Front run the FULL plinth width ('out' past
  // the lateral panels); Left/Right sit between them (depth - 2T).
  const lateralLen = D - 2 * T;
  const centers = {
    left:  { x: cx - (W / 2 - T / 2), y: centerY, z: cz },
    right: { x: cx + (W / 2 - T / 2), y: centerY, z: cz },
    back:  { x: cx, y: centerY, z: cz - (D / 2 - T / 2) },
    front: { x: cx, y: centerY, z: cz + (D / 2 - T / 2) },
  };
  const lateralDims = { width: lateralLen, height: heightMm, thickness: T };
  const frontBackDims = { width: W, height: heightMm, thickness: T };

  // ---- reinforcement panels (inside the 4 walls) ----
  // X-running ribs (parallel to back/front) span the full inner width;
  // depth-running ribs are CUT into one segment per bay between those
  // (and the back/front walls), so no two panels ever overlap.
  const innerW = W - 2 * T, innerD = D - 2 * T;
  const ribs = [];
  const nz = computeRibLayout(innerD, T);  // x-running ribs, spread along depth
  const nx = computeRibLayout(innerW, T);  // depth-running ribs, spread along width
  const zStart = zMin + T, xStart = xMin + T;
  const yC = centerY;
  const bayLen = nz.gap;
  if (innerW >= MIN_PANEL_DIM_MM && nz.count > 0 && nz.gap >= MIN_PANEL_DIM_MM) {
    for (let i = 1; i <= nz.count; i++) {
      ribs.push({
        role: `rib-x-${i}`,
        center: { x: cx, y: yC, z: zStart + i * nz.gap + (i - 1) * T + T / 2 },
        rotation: PARALLEL_ROTATION,
        dims: { width: innerW, height: heightMm, thickness: T },
      });
    }
  }
  if (nx.count > 0 && bayLen >= MIN_PANEL_DIM_MM) {
    for (let j = 1; j <= nx.count; j++) {
      const rx = xStart + j * nx.gap + (j - 1) * T + T / 2;
      for (let k = 0; k <= nz.count; k++) {
        const bayStart = zStart + k * (nz.gap + T);
        ribs.push({
          role: `rib-y-${j}-${k + 1}`,
          center: { x: rx, y: yC, z: bayStart + nz.gap / 2 },
          rotation: VERTICAL_ROTATION,
          dims: { width: nz.gap, height: heightMm, thickness: T },
        });
      }
    }
  }

  return {
    ok: true,
    groupId,
    material,
    thicknessMm: T,
    heightMm,
    edgeFit,
    left:  { center: centers.left,  rotation: VERTICAL_ROTATION, dims: lateralDims },
    right: { center: centers.right, rotation: VERTICAL_ROTATION, dims: lateralDims },
    back:  { center: centers.back,  rotation: PARALLEL_ROTATION, dims: frontBackDims },
    front: { center: centers.front, rotation: PARALLEL_ROTATION, dims: frontBackDims },
    ribs,
  };
}

/**
 * Creates the 4 real panel nodes from a successful placement. Joins
 * the OWNING BOX's own existing groupId (not a new one of its own) —
 * same reasoning as features/drawer.js#createDrawerBoxNodes joining
 * its front's groupId: the plinth is part of that box as far as
 * selection/grouping/deletion are concerned, not a separate unit.
 * Reuses the box's own EXISTING basePosition (looked up off any
 * current member) rather than {0,0,0}, for the same reason
 * createDrawerBoxNodes does — if the whole box is ever dragged as a
 * group, every member shares one basePosition anchor; a plinth with
 * its own zero anchor would silently stop following the box.
 *
 * @param {Array} panels - raw graph (read-only, just to find the box's existing basePosition)
 * @param {ReturnType<typeof computePlinthPlacement>} placement - a successful (ok:true) result
 * @returns {Array} 4 new panel nodes (left, right, back, front)
 */
export function createPlinthNodes(panels, placement) {
  const basePosition = panels.find((p) => p.groupId === placement.groupId)?.basePosition || { x: 0, y: 0, z: 0 };
  const specs = [
    ...(placement.skipPerimeter ? [] : PERIMETER_ROLES.map((role) => ({ role, ...placement[role] }))),
    ...(placement.ribs || []),
  ];
  return specs.map((spec) => {
    const role = spec.role;
    const node = createPanelNode({
      name: role.startsWith('rib-') ? `Plinth Rib ${role.slice(4)}` : `Plinth ${role[0].toUpperCase()}${role.slice(1)}`,
      material: placement.material,
      rotation: spec.rotation,
      groupId: placement.groupId,
      isBoxPanel: true,
      // Derived from the owning box's own Bottom panel (see
      // computePlinthPlacement above) — never something to drag or
      // type a number into directly, same reasoning (and same
      // lockedMoveAxes) as a drawer box's own 4 panels.
      isPlinthPanel: true,
      plinthRole: role,
      plinthEdgeFit: placement.edgeFit, // shared by every plinth panel — see applyPlinthAdjustment
      isPlinthRib: role.startsWith('rib-'),
      lockedMoveAxes: ['x', 'y', 'z'],
      ...spec.dims,
    });
    node.basePosition = basePosition;
    node.offset = {
      x: spec.center.x - basePosition.x,
      y: spec.center.y - basePosition.y,
      z: spec.center.z - basePosition.z,
    };
    return node;
  });
}

/**
 * Re-derives an EXISTING plinth's 4 panels in place — the owning box's
 * Bottom possibly having moved/resized since, and/or a new heightMm —
 * same "find existing nodes by role, patch dims+offset, keep their
 * own id" pattern features/drawer.js#applyDrawerAdjustmentsForGroup
 * already uses for a drawer's own box panels. This is what
 * ui/properties.js's Plinth height field (modeller-main.js#
 * updateSelectedPlinthHeight) calls.
 *
 * No-op (returns `panels` unchanged) if this group has no plinth, or
 * if computePlinthPlacement can't currently place one (e.g. the
 * owning Bottom panel is gone) — leaves the plinth at its last-known
 * geometry rather than erase it, same "don't break what you can't
 * currently fix" rule computeDrawerRecompute already follows.
 *
 * @param {Array} panels - raw graph
 * @param {string} groupId
 * @param {number} heightMm
 * @returns {Array} patched panels
 */
export function applyPlinthAdjustment(panels, groupId, heightMm, edgeFit) {
  const existing = panels.filter((p) => p.groupId === groupId && p.isPlinthPanel);
  if (existing.length === 0) return panels;

  const sample = existing.find((p) => p.plinthRole === 'left') || existing[0];
  const placement = computePlinthPlacement(panels, groupId, {
    heightMm: heightMm ?? sample.height,
    material: sample.material,
    thicknessMm: sample.thickness,
    edgeFit: edgeFit ?? sample.plinthEdgeFit,
  });
  if (!placement.ok) return panels;

  const delta = placement.heightMm - sample.height; // box rises/lowers so the plinth's bottom stays put
  const specByRole = new Map([
    ...PERIMETER_ROLES.map((role) => [role, placement[role]]),
    ...placement.ribs.map((r) => [r.role, r]),
  ]);
  const have = new Set(existing.map((p) => p.plinthRole));

  // patch existing (keeps ids), drop ribs that no longer exist
  let next = panels
    .filter((p) => !(p.groupId === groupId && p.isPlinthPanel && !specByRole.has(p.plinthRole)))
    .map((p) => {
      if (!(p.groupId === groupId && p.isPlinthPanel)) return p;
      const spec = specByRole.get(p.plinthRole);
      return { ...p, ...spec.dims, plinthEdgeFit: placement.edgeFit, offset: { x: spec.center.x - p.basePosition.x, y: spec.center.y - p.basePosition.y, z: spec.center.z - p.basePosition.z } };
    });

  // add ribs that are new (e.g. the plinth grew past a spacing threshold)
  const missing = placement.ribs.filter((r) => !have.has(r.role));
  if (missing.length) {
    next = [...next, ...createPlinthNodes(panels, { ...placement, ribs: missing, skipPerimeter: true })];
  }
  return shiftGroupY(next, groupId, delta);
}

/**
 * Shifts EVERY member of a group (carcass panels, shelves, doors,
 * drawers, plinth) up/down by dy mm via their shared basePosition —
 * position = basePosition + offset, so this moves the whole group
 * without touching any offset or constraint.
 */
export function shiftGroupY(panels, groupId, dy) {
  if (!dy) return panels;
  return panels.map((p) => (p.groupId === groupId
    ? { ...p, basePosition: { ...p.basePosition, y: p.basePosition.y + dy } }
    : p));
}

/**
 * Builds the plinth under the box AND raises the whole box by the
 * plinth's height, so the plinth stands where the box's bottom used
 * to be (e.g. on the floor).
 *
 * @returns {{ok:true, panels:Array, groupId:string, heightMm:number}
 *   | {ok:false, reason:string}}
 */
export function addPlinthAndRaiseBox(panels, groupId, spec = {}) {
  if (panels.some((p) => p.groupId === groupId && p.isPlinthPanel)) {
    return { ok: false, reason: 'already-has-plinth' };
  }
  const placement = computePlinthPlacement(panels, groupId, spec);
  if (!placement.ok) return placement;

  const nodes = createPlinthNodes(panels, placement);
  const next = shiftGroupY([...panels, ...nodes], groupId, placement.heightMm);
  return { ok: true, panels: next, groupId, heightMm: placement.heightMm };
}

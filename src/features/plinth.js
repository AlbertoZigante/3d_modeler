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
 * BOX-AS-GENERATOR, ONE LEVEL DOWN: reuses features/box.js's own
 * computeBoxLayout PURE MATH directly, rather than a second copy of
 * the same butted-corner arithmetic — two throwaway, zero-thickness
 * "top"/"bottom" shaped exactly like computeBoxLayout expects (so
 * left/right's own height and back/front's own vertical extent come
 * out right), then only the 4 REAL panels survive into the result.
 * Left/right run the full depth; back/front sit inset between them,
 * at DEFAULT_EDGE_FIT ('in' on every edge — i.e. no .edgeFit field at
 * all, same "nothing set = the plain original construction" reasoning
 * box.js's own resolvePanelFit already documents) rather than the
 * 'out' a carcass's own Back wall uses — 'out' would make the plinth's
 * true footprint W × (D+2T), overshooting the Bottom panel's own
 * boundary by a thickness at each end; 'in' keeps it exactly W × D,
 * flush on all four sides with what it's sitting under, which is what
 * "gets its boundaries" means here.
 */
import { createPanelNode, MIN_PANEL_DIM_MM } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';
import { VERTICAL_ROTATION, PARALLEL_ROTATION } from '../shared/geometry.js';
import { findBoxSibling, computeBoxLayout } from './box.js';

export const DEFAULT_PLINTH_HEIGHT_MM = 60;
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

  const W = bottom.width;  // Bottom's own full outer width (box.js's own header: "Top/Bottom always run the full outer width")
  const D = bottom.height; // Bottom's own "height" field IS its depth footprint — HORIZONTAL_ROTATION convention (width->x, height->z, thickness->y)
  const T = thicknessMm;

  if ((W - 2 * T) < MIN_PANEL_DIM_MM || D < MIN_PANEL_DIM_MM || heightMm < MIN_PANEL_DIM_MM) {
    return { ok: false, reason: 'panel-too-short' };
  }

  const topY = bottom.position.y - bottom.thickness / 2; // Bottom's own underside — the plinth's real top edge, flush
  const centerY = topY - heightMm / 2;

  // Zero-thickness throwaway caps — see this file's own header on why
  // computeBoxLayout needs a top/bottom pair at all when neither is a
  // real panel here. Zero thickness means their INNER face (what
  // left/right/back/front actually key off) sits exactly at their own
  // offset, i.e. exactly at the plinth's real top/bottom edges, with
  // nothing shaved off for a cap that doesn't exist.
  const capTop = { offset: { y: heightMm / 2 }, thickness: 0 };
  const capBottom = { offset: { y: -heightMm / 2 }, thickness: 0 };
  const left = { offset: { x: -(W / 2 - T / 2), y: 0, z: 0 }, thickness: T };
  const right = { offset: { x: +(W / 2 - T / 2), y: 0, z: 0 }, thickness: T };
  const back = { offset: { x: 0, y: 0, z: -(D / 2 - T / 2) }, thickness: T };
  const front = { offset: { x: 0, y: 0, z: +(D / 2 - T / 2) }, thickness: T };

  const layout = computeBoxLayout({ left, right, top: capTop, bottom: capBottom, back, front });

  const centerFor = (role) => ({
    x: bottom.position.x + layout[role].offset.x,
    y: centerY + layout[role].offset.y,
    z: bottom.position.z + layout[role].offset.z,
  });

  return {
    ok: true,
    groupId,
    material,
    thicknessMm: T,
    heightMm,
    left:  { center: centerFor('left'),  rotation: VERTICAL_ROTATION, dims: { width: layout.left.width,  height: layout.left.height,  thickness: T } },
    right: { center: centerFor('right'), rotation: VERTICAL_ROTATION, dims: { width: layout.right.width, height: layout.right.height, thickness: T } },
    back:  { center: centerFor('back'),  rotation: PARALLEL_ROTATION, dims: { width: layout.back.width,  height: layout.back.height,  thickness: T } },
    front: { center: centerFor('front'), rotation: PARALLEL_ROTATION, dims: { width: layout.front.width, height: layout.front.height, thickness: T } },
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
  return ['left', 'right', 'back', 'front'].map((role) => {
    const spec = placement[role];
    const node = createPanelNode({
      name: `Plinth ${role[0].toUpperCase()}${role.slice(1)}`,
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
export function applyPlinthAdjustment(panels, groupId, heightMm) {
  const existing = panels.filter((p) => p.groupId === groupId && p.isPlinthPanel);
  if (existing.length === 0) return panels;

  const sample = existing[0];
  const placement = computePlinthPlacement(panels, groupId, { heightMm, material: sample.material, thicknessMm: sample.thickness });
  if (!placement.ok) return panels;

  let next = panels;
  ['left', 'right', 'back', 'front'].forEach((role) => {
    const spec = placement[role];
    next = next.map((p) => (p.groupId === groupId && p.isPlinthPanel && p.plinthRole === role
      ? { ...p, ...spec.dims, offset: { x: spec.center.x - p.basePosition.x, y: spec.center.y - p.basePosition.y, z: spec.center.z - p.basePosition.z } }
      : p));
  });
  return next;
}

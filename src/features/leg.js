/**
 * features/leg.js
 *
 * LEGS — 4 square feet under a box's own Bottom panel, one per
 * corner. Same shape of feature as features/plinth.js: derived from
 * the owning box's Bottom (never hand-placed), same group as the box,
 * and adding them RAISES the whole box by the leg height so the legs
 * stand where the Bottom used to rest.
 *
 * Each leg is a 30 x 30 mm block, 70 mm tall, set 10 mm in from the
 * Bottom's outer edge (leg face to Bottom edge), rendered black.
 */
import { createPanelNode, computeWorldHalfExtents } from '../modeller/modules.js';
import { resolveConstraints } from '../modeller/snap.js';
import { VERTICAL_ROTATION } from '../shared/geometry.js';
import { findBoxSibling } from './box.js';
import { shiftGroupY } from './plinth.js';

export const LEG_SIZE_MM = 30;
export const LEG_HEIGHT_MM = 70;
export const LEG_INSET_MM = 10;
export const LEG_MATERIAL = 'Black Leg 30x30';
export const LEG_COLOR = 0x151515;

const LEG_ROLES = ['back-left', 'back-right', 'front-left', 'front-right'];

/**
 * @returns {{ok:true, groupId, legs:Array<{role,center,dims}>, heightMm}
 *   | {ok:false, reason:'no-bottom-panel'|'panel-too-short'}}
 */
export function computeLegPlacement(panels, groupId) {
  const bottomRaw = findBoxSibling(panels, groupId, 'Bottom');
  if (!bottomRaw) return { ok: false, reason: 'no-bottom-panel' };
  const bottom = resolveConstraints(panels).find((r) => r.id === bottomRaw.id);
  if (!bottom) return { ok: false, reason: 'no-bottom-panel' };

  const h = computeWorldHalfExtents(bottom);
  const xMin = bottom.position.x - h.x, xMax = bottom.position.x + h.x;
  const zMin = bottom.position.z - h.z, zMax = bottom.position.z + h.z;
  const reach = LEG_INSET_MM + LEG_SIZE_MM;
  if ((xMax - xMin) < 2 * reach || (zMax - zMin) < 2 * reach) return { ok: false, reason: 'panel-too-short' };

  const topY = bottom.position.y - bottom.thickness / 2; // Bottom's underside
  const y = topY - LEG_HEIGHT_MM / 2;
  const xs = { left: xMin + reach - LEG_SIZE_MM / 2, right: xMax - reach + LEG_SIZE_MM / 2 };
  const zs = { back: zMin + reach - LEG_SIZE_MM / 2, front: zMax - reach + LEG_SIZE_MM / 2 };

  const legs = LEG_ROLES.map((role) => {
    const [zSide, xSide] = role.split('-');
    return { role, center: { x: xs[xSide], y, z: zs[zSide] } };
  });
  return { ok: true, groupId, legs, heightMm: LEG_HEIGHT_MM };
}

export function createLegNodes(panels, placement) {
  const basePosition = panels.find((p) => p.groupId === placement.groupId)?.basePosition || { x: 0, y: 0, z: 0 };
  return placement.legs.map((leg) => {
    const node = createPanelNode({
      name: `Leg ${leg.role}`,
      material: LEG_MATERIAL,
      rotation: VERTICAL_ROTATION, // width -> z, height -> y, thickness -> x
      groupId: placement.groupId,
      isBoxPanel: true,
      isLeg: true,
      legRole: leg.role,
      displayColor: LEG_COLOR,
      lockedMoveAxes: ['x', 'y', 'z'],
      width: LEG_SIZE_MM,
      height: LEG_HEIGHT_MM,
      thickness: LEG_SIZE_MM,
    });
    node.basePosition = basePosition;
    node.offset = {
      x: leg.center.x - basePosition.x,
      y: leg.center.y - basePosition.y,
      z: leg.center.z - basePosition.z,
    };
    return node;
  });
}

/**
 * Builds the 4 legs and raises the whole box by the leg height.
 * @returns {{ok:true, panels, groupId, heightMm}|{ok:false, reason}}
 */
export function addLegsAndRaiseBox(panels, groupId) {
  if (panels.some((p) => p.groupId === groupId && p.isLeg)) return { ok: false, reason: 'already-has-legs' };
  if (panels.some((p) => p.groupId === groupId && p.isPlinthPanel)) return { ok: false, reason: 'has-plinth' };
  const placement = computeLegPlacement(panels, groupId);
  if (!placement.ok) return placement;
  const next = shiftGroupY([...panels, ...createLegNodes(panels, placement)], groupId, placement.heightMm);
  return { ok: true, panels: next, groupId, heightMm: placement.heightMm };
}

/**
 * Re-seats existing legs on the Bottom's corners after a box resize.
 * No-op when the group has no legs or no placement is currently possible.
 */
export function applyLegAdjustment(panels, groupId) {
  const existing = panels.filter((p) => p.groupId === groupId && p.isLeg);
  if (existing.length === 0) return panels;
  const placement = computeLegPlacement(panels, groupId);
  if (!placement.ok) return panels;
  const byRole = new Map(placement.legs.map((l) => [l.role, l]));
  return panels.map((p) => {
    if (!(p.groupId === groupId && p.isLeg)) return p;
    const leg = byRole.get(p.legRole);
    if (!leg) return p;
    return { ...p, offset: { x: leg.center.x - p.basePosition.x, y: leg.center.y - p.basePosition.y, z: leg.center.z - p.basePosition.z } };
  });
}

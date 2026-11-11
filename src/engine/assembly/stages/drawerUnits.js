/**
 * drawerUnits.js — one entry per drawer (front + its 4 box panels +
 * runners + handle), grouped when drawers are exactly identical.
 *
 * A drawer is built as ONE unit around its front, in this order:
 *   1. drawer guide (runner half) on the left side, then on the right side
 *   2. left side, then right side, attached to the front
 *   3. back panel
 *   4. bottom panel
 *   5. handle
 * Identical drawers are described once with a repeat count (x2, x3...).
 */
import { STRUCTURAL_JOINT_TYPES } from '../constants.js';

const BOX_ROLES = ['left', 'right', 'back', 'bottom'];

const round1 = (v) => Math.round(Number(v) * 10) / 10;

/** Everything that makes two drawers physically identical. */
function panelSignature(ctx, id) {
  const raw = ctx.rawById.get(id);
  const res = ctx.resolvedById.get(id);
  return [
    raw?.drawerBoxRole ?? (raw?.isDrawerFront ? 'front' : '?'),
    round1(res?.width), round1(res?.height), round1(res?.thickness),
    raw?.material ?? '',
    JSON.stringify(raw?.bandedEdges ?? []),
  ].join(':');
}

function hardwareSignature(entry) {
  if (!entry) return '-';
  return [entry.hardware?.kind, entry.hardware?.series, entry.hardware?.lengthMm].join(':');
}

/** @returns {Array<object>} drawer units sorted by front piece code */
export function collectDrawerUnits(ctx) {
  const { rawById, resolvedById, codeOf, hardwarePlan, handleByPanel, clusterList } = ctx;
  const frontIds = [...rawById.values()]
    .filter((p) => p.isDrawerFront && resolvedById.get(p.id) && !resolvedById.get(p.id).hidden)
    .map((p) => p.id)
    .sort((a, b) => codeOf(a).localeCompare(codeOf(b)));

  return frontIds.map((frontId, i) => {
    const box = {};
    rawById.forEach((p) => {
      if (p.isDrawerBoxPanel && p.drawerBoxFrontId === frontId && !resolvedById.get(p.id)?.hidden) {
        box[p.drawerBoxRole] = p.id;
      }
    });
    const boxIds = BOX_ROLES.map((r) => box[r]).filter(Boolean);
    const runnerBySide = {};
    ['left', 'right'].forEach((side) => {
      runnerBySide[side] = box[side] ? hardwarePlan.runners.find((r) => r.panelA === box[side]) ?? null : null;
    });
    const unit = {
      number: i + 1,
      frontId,
      box,
      boxIds,
      unitPanelIds: [frontId, ...boxIds],
      runnerBySide,
      handle: handleByPanel.get(frontId) ?? null,
      cluster: clusterList.find((c) => c.ids.has(box.left ?? frontId)) ?? clusterList.find((c) => c.ids.has(frontId)),
    };
    unit.signature = [
      panelSignature(ctx, frontId),
      ...BOX_ROLES.map((r) => (box[r] ? panelSignature(ctx, box[r]) : '-')),
      hardwareSignature(runnerBySide.left), hardwareSignature(runnerBySide.right),
      hardwareSignature(unit.handle),
    ].join('|');
    return unit;
  });
}

/** Groups identical drawers; the first of each group is the one described. */
export function groupIdenticalDrawers(units) {
  const groups = new Map();
  units.forEach((u) => {
    if (!groups.has(u.signature)) groups.set(u.signature, []);
    groups.get(u.signature).push(u);
  });
  return [...groups.values()];
}

function jointsBetween(ctx, panelId, otherIds) {
  const others = new Set(otherIds);
  return ctx.joints.filter((j) => STRUCTURAL_JOINT_TYPES.has(j.type)
    && ((j.panelA === panelId && others.has(j.panelB)) || (j.panelB === panelId && others.has(j.panelA))));
}

/**
 * The ordered step descriptors of ONE drawer (same shape for every drawer
 * of a group, so the Nth descriptor of the leader and of its twins describe
 * the same step).
 */
export function drawerStepDescriptors(ctx, unit) {
  const { codeOf, hardwarePlan } = ctx;
  const front = unit.frontId;
  const frontCode = codeOf(front);
  const out = [];
  const placed = [front];

  ['left', 'right'].forEach((side) => {
    const id = unit.box[side];
    const runner = unit.runnerBySide[side];
    if (!id || !runner) return;
    out.push({
      key: `guide-${side}`,
      kind: 'pre_install',
      phase: 'prepare',
      panelIds: [id],
      otherPanelIds: [],
      jointIds: [],
      hardware: [runner],
      orientation: 'flat',
      description: `Fit drawer guide ${runner.displayId} on the ${side} side ${codeOf(id)}.`,
      instruction: `Fit drawer guide ${runner.displayId} on the ${side} side ${codeOf(id)} while it is still loose.`,
    });
  });

  const attach = (id, role, others, instruction) => {
    const joints = jointsBetween(ctx, id, others);
    out.push({
      key: `attach-${role}`,
      kind: 'join',
      phase: 'subassembly',
      panelIds: [id],
      otherPanelIds: others,
      jointIds: joints.map((j) => j.id),
      hardware: hardwarePlan.fasteners.filter((f) => joints.some((j) => j.id === f.jointId)),
      jointObjects: joints,
      orientation: 'flat',
      description: `Attach ${codeOf(id)} to ${others.map(codeOf).join(', ')}.`,
      instruction,
    });
    placed.push(id);
  };

  if (unit.box.left) attach(unit.box.left, 'left', [front], `Lay the drawer front ${frontCode} face down, then attach the left side ${codeOf(unit.box.left)} to it.`);
  if (unit.box.right) attach(unit.box.right, 'right', [front], `Attach the right side ${codeOf(unit.box.right)} to the drawer front ${frontCode}.`);
  if (unit.box.back) attach(unit.box.back, 'back', [unit.box.left, unit.box.right].filter(Boolean), `Attach the back panel ${codeOf(unit.box.back)} between the two sides.`);
  if (unit.box.bottom) attach(unit.box.bottom, 'bottom', placed.filter((id) => id !== front), `Fit the drawer bottom ${codeOf(unit.box.bottom)} into the box.`);

  if (unit.handle) {
    out.push({ key: 'handle', handle: true, panelIds: [front] });
  }
  return out;
}

/**
 * Stage 2 — drawers.
 *
 * Every drawer is built as one component around its front:
 *   guides on the 2 sides -> sides on the front -> back -> bottom -> handle.
 * Identical drawers are described ONCE with a repeat count (x2, x3...);
 * the twin drawers' hardware rides along in `repeatHardware` so the
 * hardware totals stay right.
 */
import { collectDrawerUnits, groupIdenticalDrawers, drawerStepDescriptors } from './drawerUnits.js';
import { emitClusterSteps, emitHandleStep } from './clusterSteps.js';

export function runDrawers(ctx) {
  const units = collectDrawerUnits(ctx);
  const claimed = new Set();

  groupIdenticalDrawers(units).forEach((group) => {
    const [leader, ...twins] = group;
    const count = group.length;
    const numbers = group.map((u) => u.number);
    ctx.setUnit({
      kind: 'drawer',
      title: count > 1 ? `DRAWER ×${count}` : `DRAWER ${leader.number}`,
      subtitle: count > 1
        ? `Drawers ${numbers.join(', ')} are identical — build this drawer ${count} times`
        : null,
      unitPanelIds: leader.unitPanelIds,
      subassemblyId: leader.cluster?.id ?? null,
      subassemblyName: count > 1 ? `Drawers ${numbers.join(', ')} (×${count})` : `Drawer ${leader.number}`,
      repeatCount: count,
      repeatLabels: numbers.map((n) => `Drawer ${n}`),
    });

    const leaderSteps = drawerStepDescriptors(ctx, leader);
    const twinSteps = twins.map((u) => drawerStepDescriptors(ctx, u));
    leaderSteps.forEach((descriptor, i) => {
      if (descriptor.handle) {
        emitHandleStepWithTwins(ctx, descriptor.panelIds[0], twins);
        return;
      }
      const repeatHardware = twinSteps.flatMap((steps) => steps[i]?.hardware ?? []);
      ctx.emitStep({ ...descriptor, repeatHardware });
    });
    group.forEach((u) => u.unitPanelIds.forEach((id) => claimed.add(id)));
  });

  // Fallback: drawer boxes with no front (or other drawer panels the unit
  // builder did not claim) keep the generic cluster build.
  ctx.setUnit(null);
  ctx.clustersOfRole('drawer_box').forEach((cluster) => {
    if (![...cluster.ids].every((id) => claimed.has(id))) emitClusterSteps(ctx, cluster);
  });
}

function emitHandleStepWithTwins(ctx, frontId, twins) {
  const before = ctx.handleByPanel.get(frontId);
  const twinHandles = twins.map((u) => u.handle).filter(Boolean);
  if (!before) return;
  // emitHandleStep reads the entry from the map; attach the twins' entries
  // to a shallow copy so the step carries them in repeatHardware.
  const original = ctx.emitStep;
  ctx.emitStep = (partial) => original({ ...partial, repeatHardware: twinHandles });
  try { emitHandleStep(ctx, frontId); } finally { ctx.emitStep = original; }
}

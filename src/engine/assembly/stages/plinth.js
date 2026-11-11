/**
 * Stage 4 — plinth panels.
 * The plinth frame / kickboards are built as their own component and set
 * aside; they are fitted to the finished carcass in integration.
 */
import { emitClusterSteps } from './clusterSteps.js';

export function runPlinth(ctx) {
  const plinths = ctx.clustersOfRole('plinth');
  plinths.forEach((cluster) => {
    ctx.setUnit({
      kind: 'plinth',
      title: plinths.length > 1 ? `PLINTH ${cluster.ordinal}` : 'PLINTH',
      unitPanelIds: [...cluster.ids],
    });
    emitClusterSteps(ctx, cluster);
  });
}

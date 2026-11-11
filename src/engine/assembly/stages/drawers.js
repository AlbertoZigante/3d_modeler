/**
 * Stage 2 — drawer panels.
 * Drawer boxes first (the runner half that fastens to the box side is
 * fitted before that side's first joint), then the drawer fronts and
 * their handles.
 */
import { emitClusterSteps, emitHandleSteps } from './clusterSteps.js';

export function runDrawers(ctx) {
  ctx.clustersOfRole('drawer_box').forEach((cluster) => emitClusterSteps(ctx, cluster));
  ctx.clustersOfRole('drawer_front').forEach((cluster) => {
    emitClusterSteps(ctx, cluster);
    emitHandleSteps(ctx, cluster);
  });
}

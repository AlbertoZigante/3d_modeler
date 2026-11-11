/**
 * Stage 1 — doors + handles.
 * Door panel (with its hinge cups), then the handle. Each door is a
 * finished, set-aside sub-assembly before anything else is touched.
 */
import { emitClusterSteps, emitHandleSteps } from './clusterSteps.js';

export function runDoors(ctx) {
  ctx.clustersOfRole('door').forEach((cluster) => {
    emitClusterSteps(ctx, cluster);
    emitHandleSteps(ctx, cluster);
  });
}

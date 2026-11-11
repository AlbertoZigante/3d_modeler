/**
 * Stage 4 — plinth panels.
 * The plinth frame / kickboards are built as their own sub-assembly and
 * set aside; they are fitted to the finished carcass in integration.
 */
import { emitClusterSteps } from './clusterSteps.js';

export function runPlinth(ctx) {
  ctx.clustersOfRole('plinth').forEach((cluster) => emitClusterSteps(ctx, cluster));
}

/**
 * Stage 5 — the actual furniture body (and any cluster that is none of
 * the earlier kinds): bottom -> verticals -> shelves -> back -> top,
 * ordered by clusterOrdering.js.
 */
import { emitClusterSteps } from './clusterSteps.js';

export function runCarcass(ctx) {
  ctx.clusterList
    .filter((cluster) => !ctx.EARLY_CLUSTER_ROLES.has(cluster.role))
    .forEach((cluster) => emitClusterSteps(ctx, cluster));
}

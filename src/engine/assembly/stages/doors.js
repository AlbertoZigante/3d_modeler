/**
 * Stage 1 — doors + handles.
 * Door panel (with its hinge cups), then the handle. Each door is a
 * finished, set-aside sub-assembly before anything else is touched.
 */
import { emitClusterSteps, emitHandleSteps } from './clusterSteps.js';

export function runDoors(ctx) {
  const doors = ctx.clustersOfRole('door');
  doors.forEach((cluster) => {
    ctx.setUnit({
      kind: 'door',
      title: doors.length > 1 ? `DOOR ${cluster.ordinal}` : 'DOOR',
      unitPanelIds: [...cluster.ids],
    });
    emitClusterSteps(ctx, cluster);
    emitHandleSteps(ctx, cluster);
  });
}

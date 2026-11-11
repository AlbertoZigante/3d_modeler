/**
 * Emits the steps of ONE rigid sub-assembly (cluster): hardware that has
 * to go on a panel before its first joint, then the panel's own join /
 * start step. Shared by every stage that builds a cluster.
 */
import { desiredOrientation, roleOfStepPanel } from '../roles.js';
import { describeHandlePlacement } from '../handles.js';

export function emitClusterSteps(ctx, cluster) {
  const { emitStep, rawById, codeOf, hardwarePlan, preInstallByPanel, integrationPanelIds } = ctx;
  const { order } = cluster;

  order.forEach(({ newPanel, joints: connectingJoints }) => {
    const role = roleOfStepPanel(newPanel, rawById);
    const pre = preInstallByPanel.get(newPanel);

    if (pre) {
      pre.forEach((hw) => {
        emitStep({
          kind: 'pre_install',
          phase: 'prepare',
          panelIds: [newPanel],
          otherPanelIds: [],
          jointIds: [],
          hardware: [hw],
          orientation: desiredOrientation(role),
          description: `Prepare ${codeOf(newPanel)} with ${hw.hardware.brand ?? 'Generic'} ${hw.hardware.series ?? hw.hardware.kind} hardware (${hw.displayId}) before the panel joins the assembly.`,
        });
      });
    }

    if (connectingJoints.length === 0) {
      const clusterHasOtherPanels = order.length > 1;
      const hasKnownFutureRole = pre || integrationPanelIds.has(newPanel) || role === 'plinth'; // a plinth is fitted by the plinth integration step
      let description;
      if (clusterHasOtherPanels) {
        description = `Start the ${role === 'door' ? 'door' : role === 'drawer_box' ? 'drawer' : role === 'plinth' ? 'plinth' : 'sub-assembly'} with ${codeOf(newPanel)}.`;
      } else if (hasKnownFutureRole) {
        description = `Prepare ${codeOf(newPanel)} and set it aside ready for final integration.`;
      } else {
        description = `Place ${codeOf(newPanel)} — no structural joint or hardware association found for it yet (see the known-gap note).`;
      }
      const attached = clusterHasOtherPanels || hasKnownFutureRole;
      emitStep({
        kind: attached ? 'join' : 'unattached',
        phase: attached ? (role === 'door' || role === 'drawer_box' ? 'subassembly' : 'internal') : 'unattached',
        panelIds: [newPanel],
        otherPanelIds: [],
        jointIds: [],
        hardware: [],
        orientation: desiredOrientation(role),
        description,
      });
    } else {
      const fastenerEntries = hardwarePlan.fasteners.filter((f) => connectingJoints.some((j) => j.id === f.jointId));
      const otherPanelIds = [...new Set(connectingJoints.flatMap((j) => [j.panelA, j.panelB]).filter((id) => id !== newPanel))];
      const closure = role === 'back' || role === 'top';
      emitStep({
        kind: 'join',
        phase: closure ? 'closure' : (role === 'vertical' || role === 'horizontal' ? 'internal' : 'subassembly'),
        panelIds: [newPanel],
        otherPanelIds,
        jointIds: connectingJoints.map((j) => j.id),
        hardware: fastenerEntries,
        jointObjects: connectingJoints,
        orientation: desiredOrientation(role),
        description: closure
          ? `Install ${codeOf(newPanel)} as a ${role} closure after all accessible internal components are in place.`
          : `Attach ${codeOf(newPanel)} to ${otherPanelIds.map(codeOf).join(', ')} (${connectingJoints.map((j) => j.type).join(', ')}).`,
      });
    }
  });
}

/**
 * Handle step for ONE door / drawer front, emitted after the panel itself
 * is built (handles go on while the front is still flat and off the
 * furniture).
 */
export function emitHandleStep(ctx, panelId) {
  const { emitStep, codeOf, handleByPanel } = ctx;
  const handle = handleByPanel.get(panelId);
  if (!handle) return;
  const what = ctx.rawById.get(panelId)?.isDoor ? 'door' : 'drawer front';
  emitStep({
    kind: 'fit_handle',
    phase: 'prepare',
    action: 'install',
    panelIds: [panelId],
    otherPanelIds: [],
    jointIds: [],
    hardware: [handle],
    orientation: 'flat',
    description: `Fit handle ${handle.displayId} on ${what} ${codeOf(panelId)}.`,
    instruction: `Fit handle ${handle.displayId} (${handle.hardware.series}) on ${codeOf(panelId)}: ${describeHandlePlacement(handle)}.`,
    warnings: ['Fit the handle while the panel is flat on a protected surface.'],
  });
}

/** Handle steps for every door / drawer front of a cluster. */
export function emitHandleSteps(ctx, cluster) {
  cluster.order.forEach(({ newPanel }) => emitHandleStep(ctx, newPanel));
}

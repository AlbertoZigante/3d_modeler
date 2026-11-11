/**
 * Stage 6 — integration of finished sub-assemblies: plinth fitted to the
 * carcass, drawers slid onto their runners, doors hung (hinges last).
 */
import { STRUCTURAL_JOINT_TYPES } from '../constants.js';

function fitPlinth(ctx) {
  const { emitStep, codeOf, joints, clusterList, hardwarePlan, rawById } = ctx;
  const carcassClusters = clusterList.filter((c) => c.role === 'carcass');

  ctx.clustersOfRole('plinth').forEach((plinth) => {
    const plinthIds = [...plinth.ids];
    // Real contacts between this plinth and the carcass (filtered out of
    // the rigid clusters on purpose, see makeIsSameRigidUnit).
    const touching = joints.filter((j) => STRUCTURAL_JOINT_TYPES.has(j.type)
      && ((plinth.ids.has(j.panelA) && !plinth.ids.has(j.panelB) && carcassClusters.some((c) => c.ids.has(j.panelB)))
        || (plinth.ids.has(j.panelB) && !plinth.ids.has(j.panelA) && carcassClusters.some((c) => c.ids.has(j.panelA)))));
    let carcassPanelIds = [...new Set(touching.flatMap((j) => [j.panelA, j.panelB]).filter((id) => !plinth.ids.has(id)))];
    if (!carcassPanelIds.length) {
      carcassPanelIds = carcassClusters.flatMap((c) => [...c.ids]).filter((id) => rawById.get(id)?.isBottom || rawById.get(id)?.role === 'bottom' || /bottom/i.test(rawById.get(id)?.name || ''));
    }
    const fasteners = hardwarePlan.fasteners.filter((f) => touching.some((j) => j.id === f.jointId));

    emitStep({
      kind: 'integrate',
      phase: 'integration',
      orientation: 'upright',
      panelIds: [...plinthIds, ...carcassPanelIds],
      otherPanelIds: [],
      jointIds: touching.map((j) => j.id),
      hardware: fasteners,
      jointObjects: touching,
      subassemblyId: plinth.id,
      subassemblyName: plinth.name,
      integrationSubassemblyIds: [plinth.id, ...carcassClusters.map((c) => c.id)],
      description: `Fit the plinth (${plinthIds.map(codeOf).join(', ')}) under the finished carcass${carcassPanelIds.length ? ` (${carcassPanelIds.map(codeOf).join(', ')})` : ''}.`,
    });
  });
}

function slideInDrawers(ctx) {
  const { emitStep, codeOf, featureJoints, clusterOfPanel, clusterList, hardwarePlan } = ctx;
  const slideJoints = featureJoints.filter((j) => j.kind === 'drawer_slide');
  const slideGroups = new Map(); // drawer-box cluster (as a Set) -> its slide FeatureJoints
  slideJoints.forEach((j) => {
    const cluster = clusterOfPanel.get(j.panelA);
    const key = cluster?.ids || cluster?.id || j.panelA;
    if (!slideGroups.has(key)) slideGroups.set(key, { meta: cluster, joints: [] });
    slideGroups.get(key).joints.push(j);
  });
  slideGroups.forEach(({ meta, joints: groupJoints }) => {
    const runnerEntries = hardwarePlan.runners.filter((r) => groupJoints.some((j) => j.id === `${r.panelA}:${r.panelB}:slide`));
    const drawerPanelIds = [...new Set(groupJoints.map((j) => j.panelA))];
    const carcassPanelIds = [...new Set(groupJoints.map((j) => j.panelB))];
    emitStep({
      kind: 'integrate',
      phase: 'integration',
      orientation: 'upright',
      panelIds: [...drawerPanelIds, ...carcassPanelIds],
      otherPanelIds: [],
      jointIds: groupJoints.map((j) => j.id),
      hardware: runnerEntries,
      jointObjects: groupJoints,
      subassemblyId: meta?.id ?? null,
      subassemblyName: meta?.name ?? 'Drawer assembly',
      integrationSubassemblyIds: [meta?.id, ...clusterList.filter((c) => c.role === 'carcass').map((c) => c.id)].filter(Boolean),
      description: `Slide the drawer box (${drawerPanelIds.map(codeOf).join(', ')}) into the carcass on its runners (${carcassPanelIds.map(codeOf).join(', ')}).`,
    });
  });
}

function hangDoors(ctx) {
  const { emitStep, codeOf, featureJoints, clusterOfPanel, hardwarePlan } = ctx;
  featureJoints.filter((j) => j.kind === 'door_hinge').forEach((j) => {
    const hingeEntries = hardwarePlan.hinges.filter((h) => `${h.panelA}:hinge` === j.id);
    const doorMeta = clusterOfPanel.get(j.panelA);
    const carcassMeta = clusterOfPanel.get(j.panelB);
    emitStep({
      kind: 'integrate',
      phase: 'integration',
      orientation: 'upright',
      subassemblyId: doorMeta?.id ?? null,
      subassemblyName: doorMeta?.name ?? 'Door assembly',
      integrationSubassemblyIds: [doorMeta?.id, carcassMeta?.id].filter(Boolean),
      panelIds: [j.panelA, j.panelB],
      otherPanelIds: [],
      jointIds: [j.id],
      hardware: hingeEntries,
      jointObjects: [j],
      description: `Hang ${codeOf(j.panelA)} on ${codeOf(j.panelB)} using the pre-fitted hinges.`,
    });
  });
}

export function runIntegration(ctx) {
  fitPlinth(ctx);
  slideInDrawers(ctx);
  hangDoors(ctx); // hinges always last
}

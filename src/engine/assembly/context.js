/**
 * context.js — everything the stages need, computed once per call.
 *
 * Pure data: resolves the graph, detects joints/hardware, clusters the
 * panels into rigid sub-assemblies and sorts out which hardware goes on
 * which panel. No steps are emitted here (see stepEmitter.js / stages/).
 */
import { resolveConstraints } from '../../modeller/snap.js';
import { detectJoints, detectFeatureJoints } from '../joints.js';
import { buildHardwarePlan } from '../hardware.js';
import { STRUCTURAL_JOINT_TYPES } from './constants.js';
import { computeClusters, makeIsSameRigidUnit } from './clusters.js';
import { clusterPriority, clusterRole } from './roles.js';
import { ergonomicClusterScore } from './scoring.js';
import { orderClusterPanelsPhase1 } from './clusterOrdering.js';
import { subassemblyLabel } from './humanModel.js';
import { buildHandleEntries } from './handles.js';

// Cluster roles built BEFORE the carcass (stages 1, 2 and 4).
const EARLY_CLUSTER_ROLES = new Set(['door', 'drawer_box', 'drawer_front', 'plinth']);

/** @param {Array} panels - RAW graph (not resolved) */
export function createAssemblyContext(panels) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const nameById = new Map(resolved.map((r) => [r.id, r.name || r.id]));
  const pieceCodeById = new Map(panels.map((p) => [p.id, p.pieceCode]));
  const codeOf = (id) => pieceCodeById.get(id) ?? nameById.get(id) ?? id;

  const { joints } = detectJoints(resolved);
  const featureJoints = detectFeatureJoints(panels);
  const hardwarePlan = buildHardwarePlan(panels);

  const rawById = new Map(panels.map((p) => [p.id, p]));
  const isSameRigidUnit = makeIsSameRigidUnit(rawById);
  const structuralJoints = joints.filter((j) => STRUCTURAL_JOINT_TYPES.has(j.type) && isSameRigidUnit(j.panelA, j.panelB));
  const integrationPanelIds = new Set(featureJoints.flatMap((j) => [j.panelA, j.panelB]));
  const visiblePanelIds = resolved.filter((p) => !p.hidden).map((p) => p.id);
  const clusters = computeClusters(visiblePanelIds, structuralJoints);

  // Hardware that must be fitted while its panel is still loose, keyed by
  // the panel it precedes (before that panel's first structural joint).
  const preInstallByPanel = new Map(); // panelId -> hardwarePlan entry[]
  const addPreInstall = (panelId, entry) => {
    if (!preInstallByPanel.has(panelId)) preInstallByPanel.set(panelId, []);
    preInstallByPanel.get(panelId).push(entry);
  };
  hardwarePlan.hinges.forEach((h) => {
    addPreInstall(h.panelA, h); // hinge cup on the door itself
    addPreInstall(h.panelB, h); // mounting plate on the carcass boundary panel
  });
  // Runners: the drawer-box half stays with the drawer; the carcass-side
  // guide is hoisted into its own stage (stages/guides.js).
  const guideEntries = [];
  hardwarePlan.runners.forEach((r) => {
    addPreInstall(r.panelA, r); // drawer box side
    guideEntries.push(r); // carcass side / shelf bracket
  });
  guideEntries.sort((a, b) => String(a.displayId).localeCompare(String(b.displayId)));

  const handleByPanel = buildHandleEntries(panels, resolvedById, codeOf);

  // Sub-assemblies, in a stable order: stage priority, then ergonomics.
  const clusterRoleCounts = new Map();
  const clusterList = clusters
    .map((cluster) => {
      const role = clusterRole(cluster, rawById);
      const ordinal = (clusterRoleCounts.get(role) || 0) + 1;
      clusterRoleCounts.set(role, ordinal);
      return {
        ids: cluster,
        role,
        ordinal,
        id: `SUB${String(clusters.indexOf(cluster) + 1).padStart(2, '0')}`,
        name: subassemblyLabel(role, ordinal),
        order: orderClusterPanelsPhase1(cluster, structuralJoints, resolvedById, codeOf, rawById),
      };
    })
    .sort((a, b) => {
      const pa = clusterPriority(a.role);
      const pb = clusterPriority(b.role);
      if (pa !== pb) return pa - pb;
      const ea = ergonomicClusterScore(a.ids, rawById, resolvedById);
      const eb = ergonomicClusterScore(b.ids, rawById, resolvedById);
      if (ea !== eb) return ea - eb;
      if (b.ids.size !== a.ids.size) return b.ids.size - a.ids.size;
      const ca = codeOf([...a.ids].sort()[0]);
      const cb = codeOf([...b.ids].sort()[0]);
      return ca.localeCompare(cb);
    });

  const clusterOfPanel = new Map();
  clusterList.forEach(({ ids, id, role, name }) => {
    ids.forEach((panelId) => clusterOfPanel.set(panelId, { ids, id, role, name }));
  });

  return {
    panels, resolved, resolvedById, rawById, nameById, codeOf,
    joints, featureJoints, hardwarePlan,
    structuralJoints, integrationPanelIds,
    preInstallByPanel, guideEntries, handleByPanel,
    clusterList, clusterOfPanel,
    EARLY_CLUSTER_ROLES,
    clustersOfRole: (role) => clusterList.filter((c) => c.role === role),
  };
}

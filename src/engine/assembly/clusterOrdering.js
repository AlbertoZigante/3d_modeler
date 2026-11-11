import { desiredOrientation, panelPriority, panelRole } from './roles.js';
import { ergonomicStepScore } from './scoring.js';

export function orderClusterPanelsPhase1(clusterIds, structuralJoints, resolvedById, codeOf, rawById) {
  const jointsByPanel = new Map([...clusterIds].map((id) => [id, []]));
  structuralJoints.forEach((j) => {
    if (clusterIds.has(j.panelA) && clusterIds.has(j.panelB)) {
      jointsByPanel.get(j.panelA).push(j);
      jointsByPanel.get(j.panelB).push(j);
    }
  });
  const areaOf = (id) => {
    const r = resolvedById.get(id);
    return r ? r.width * r.height : 0;
  };
  const remaining = new Set(clusterIds);
  const placed = [];
  const steps = [];
  const anchor = [...remaining].sort((a, b) => {
    const pa = panelPriority(panelRole(rawById.get(a)));
    const pb = panelPriority(panelRole(rawById.get(b)));
    if (pa !== pb) return pa - pb;
    const aa = areaOf(a), ab = areaOf(b);
    if (aa !== ab) return ab - aa;
    return codeOf(a).localeCompare(codeOf(b));
  })[0];
  remaining.delete(anchor);
  placed.push(anchor);
  steps.push({ newPanel: anchor, joints: [] });

  while (remaining.size) {
    const candidates = [];
    remaining.forEach((candidateId) => {
      const connecting = jointsByPanel.get(candidateId).filter(
        (j) => placed.includes(j.panelA) || placed.includes(j.panelB)
      );
      if (connecting.length) candidates.push({ candidateId, connecting });
    });
    if (!candidates.length) throw new Error('orderClusterPanelsPhase1: cluster is not fully connected');
    candidates.sort((a, b) => {
      const pa = panelPriority(panelRole(rawById.get(a.candidateId)));
      const pb = panelPriority(panelRole(rawById.get(b.candidateId)));
      if (pa !== pb) return pa - pb;

      // Hard role ordering wins. Within the same role, prefer the candidate
      // that is easier to support and access with the tool.
      const aRole = panelRole(rawById.get(a.candidateId));
      const bRole = panelRole(rawById.get(b.candidateId));
      const aErgo = ergonomicStepScore({
        panel: rawById.get(a.candidateId),
        resolved: resolvedById.get(a.candidateId),
        role: aRole,
        joints: a.connecting,
        orientation: desiredOrientation(aRole),
        fromOrientation: desiredOrientation(panelRole(rawById.get(placed[placed.length - 1]))),
        kind: 'join',
      }).score;
      const bErgo = ergonomicStepScore({
        panel: rawById.get(b.candidateId),
        resolved: resolvedById.get(b.candidateId),
        role: bRole,
        joints: b.connecting,
        orientation: desiredOrientation(bRole),
        fromOrientation: desiredOrientation(panelRole(rawById.get(placed[placed.length - 1]))),
        kind: 'join',
      }).score;
      if (aErgo !== bErgo) return aErgo - bErgo;
      if (b.connecting.length !== a.connecting.length) return b.connecting.length - a.connecting.length;
      const aa = areaOf(a.candidateId), ab = areaOf(b.candidateId);
      if (aa !== ab) return ab - aa;
      return codeOf(a.candidateId).localeCompare(codeOf(b.candidateId));
    });
    const best = candidates[0];
    remaining.delete(best.candidateId);
    placed.push(best.candidateId);
    steps.push({ newPanel: best.candidateId, joints: best.connecting });
  }
  return steps;
}

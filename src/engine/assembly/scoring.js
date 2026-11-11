import { desiredOrientation, panelRole } from './roles.js';

// ---------------------------------------------------------------
// Phase-2 ergonomic scoring
// ---------------------------------------------------------------
// Scores are deliberately heuristic and normalized to 0..10.  They are
// used only after hard structural/phase constraints have been respected.
// Lower is easier for a human assembler.
export function clamp10(value) { return Math.max(0, Math.min(10, value)); }

export function numericDimension(panel, keys) {
  for (const key of keys) {
    const value = Number(panel?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function panelErgonomicSize(panel, resolved) {
  const width = numericDimension(panel, ['width', 'w', 'lengthX']) || Number(resolved?.width) || 0;
  const height = numericDimension(panel, ['height', 'h', 'lengthY']) || Number(resolved?.height) || 0;
  const thickness = numericDimension(panel, ['thickness', 'depth', 'd']) || Number(resolved?.thickness) || 0;
  const area = width * height;
  const maxSpan = Math.max(width, height);
  return { width, height, thickness, area, maxSpan };
}

export function ergonomicPanelMetrics(panel, resolved) {
  const role = panelRole(panel);
  const size = panelErgonomicSize(panel, resolved);
  const area = size.area;
  const largePanel = area > 1.5 || size.maxSpan > 2.0;
  const veryLargePanel = area > 2.5 || size.maxSpan > 2.5;
  const explicitWeight = numericDimension(panel, ['weight', 'mass', 'kg', 'weightKg']);

  // Weight is preferably supplied by the model; otherwise use a conservative
  // size proxy. This is not a physical mass calculation.
  const weightScore = explicitWeight
    ? clamp10(explicitWeight / 8)
    : clamp10(area * 2.0 + (size.thickness > 0.025 ? 0.5 : 0));

  const supportScore = role === 'door' || role === 'drawer_box' || role === 'drawer_front'
    ? clamp10(1 + area * 1.5)
    : clamp10(0.5 + area * 1.7);

  return { role, ...size, largePanel, veryLargePanel, weightScore, supportScore };
}

export function jointToolAccessScore(joints) {
  if (!joints?.length) return 0;
  let score = 0;
  joints.forEach((j) => {
    const type = String(j?.type || j?.kind || '').toLowerCase();
    if (/corner|butt|t_butt/.test(type)) score += 1;
    else if (/face_to_face|edge/.test(type)) score += 1.5;
    else score += 1.25;
    if (/blind|hidden|rear|inside|interior/.test(type)) score += 2;
  });
  return clamp10(score / Math.max(1, joints.length) * 2);
}

export function ergonomicStepScore({ panel, resolved, role, joints = [], orientation, fromOrientation, kind }) {
  const metrics = ergonomicPanelMetrics(panel, resolved);
  const reach = metrics.veryLargePanel ? 5 : metrics.largePanel ? 3 : 1;
  const toolAccess = jointToolAccessScore(joints);
  const support = metrics.supportScore;
  const weight = metrics.weightScore;
  const posture =
    orientation === 'rear_access' ? 1.5 :
    orientation === 'upright' ? (metrics.largePanel ? 3.5 : 2) : 1;
  const twoPerson = panel?.requiresTwoPeople || panel?.twoPerson || panel?.assemblyTwoPerson
    ? 10
    : metrics.veryLargePanel ? 8 : metrics.largePanel ? 4 : 0;
  const reposition = fromOrientation && orientation && fromOrientation !== orientation
    && fromOrientation !== 'unknown' && orientation !== 'unknown' ? 2 : 0;
  const integrationPenalty = kind === 'integrate' ? 0.5 : 0;

  // Weighted human-effort score. Repositioning is included here so the
  // planner prefers batches that keep the furniture in one useful posture.
  const score = (
    reach * 0.20 +
    toolAccess * 0.20 +
    support * 0.18 +
    weight * 0.16 +
    posture * 0.10 +
    twoPerson * 0.10 +
    reposition * 0.04 +
    integrationPenalty * 0.02
  ) * 10;

  return {
    score: Math.round(score * 10) / 10,
    reach: Math.round(reach * 10) / 10,
    toolAccess: Math.round(toolAccess * 10) / 10,
    support: Math.round(support * 10) / 10,
    weight: Math.round(weight * 10) / 10,
    posture: Math.round(posture * 10) / 10,
    twoPerson: Math.round(twoPerson * 10) / 10,
    reposition: Math.round(reposition * 10) / 10,
  };
}

export function ergonomicClusterScore(clusterIds, rawById, resolvedById) {
  let total = 0;
  let count = 0;
  clusterIds.forEach((id) => {
    const p = rawById.get(id);
    const r = resolvedById.get(id);
    if (!p) return;
    const role = panelRole(p);
    total += ergonomicStepScore({
      panel: p,
      resolved: r,
      role,
      orientation: desiredOrientation(role),
      fromOrientation: null,
      kind: 'join',
    }).score;
    count += 1;
  });
  return count ? total / count : 0;
}

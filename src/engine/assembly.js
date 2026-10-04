/**
 * engine/assembly.js — ASSEMBLY SEQUENCING (Phase 2).
 *
 * Answers "in what order do you put this together" — the layer above
 * engine/hardware.js the way hardware.js sits above engine/joints.js:
 * geometry says where things meet, hardware says what holds them
 * together, this says in what ORDER a person actually does it.
 *
 * PHASE 3 SCOPE
 * ---------------
 * Human-first sequencing. The planner treats assembly as a sequence of
 * independent sub-assemblies plus a main carcass, with explicit ordering
 * constraints for internal parts and closure panels. It models:
 *   - doors/drawer boxes prepared independently before the carcass;
 *   - panel-level hardware pre-installed before the first structural join;
 *   - vertical dividers before the top closure;
 *   - horizontal shelves/internal parts before the back closure;
 *   - back before top by default;
 *   - final integration only after both sides are complete;
 *   - lightweight working-orientation/reposition annotations.
 *
 * This remains independent of PDF rendering. Phase 2 adds heuristic
 * ergonomics scoring for reach, tool access, support/holding, weight/size,
 * posture, two-person handling, and repositioning; hard assembly constraints
 * always take precedence over the score.
 *
 * PHASE 3 HUMAN-READABLE ASSEMBLY MODEL
 * ---------------------------------------
 * Every step is now a user-facing assembly action, with a stable stepId,
 * subassembly identity/name, action verb, instruction, prerequisites, and
 * warnings. Preparation, assembly, closure, and final integration are
 * represented explicitly so the PDF layer can render the same model without
 * reconstructing assembly logic.
 *
 * THE CORE INSIGHT: TWO KINDS OF EDGES
 * --------------------------------------
 * A Joint (corner_butt/t_butt/face_to_face — "structural" edges) means
 * two panels are RIGIDLY joined and belong in the same sub-assembly,
 * built up panel by panel. A FeatureJoint (drawer_slide/door_hinge —
 * "integration" edges) means two ALREADY-COMPLETE sub-assemblies get
 * connected to each other — you don't build a drawer box and a
 * carcass panel-by-panel as one interleaved sequence, you finish the
 * drawer box, finish the carcass, THEN slide one into the other. So:
 *
 *   1. Cluster panels into rigid sub-assemblies using ONLY structural
 *      joints (near_contact/edge_to_edge don't count either — neither
 *      is a real physical connection yet, see joints.js's own header).
 *   2. Order each cluster's own panels internally (a per-cluster
 *      topological walk).
 *   3. Only THEN schedule integration steps (drawer insertion, door
 *      hanging) — each one waits until BOTH of its clusters are fully
 *      built.
 *
 * PRE-INSTALL, UNIFIED ACROSS HINGES AND RUNNERS
 * ------------------------------------------------
 * The original plan called out "runners must be mounted before the
 * back panel closes the box" as its own special rule. Building this
 * revealed that's really a special case of a more general, more
 * defensible rule that ALSO covers hinges: hardware that fastens onto
 * a SINGLE panel (a runner's bracket on a carcass side; a hinge cup on
 * a door, or a hinge's mounting plate on ITS carcass side) should
 * always be installed while that panel is still separate and fully
 * accessible on both faces — i.e., before that panel's FIRST
 * structural joint, not "before some specific other panel". This
 * subsumes the back-panel-specific version of the rule entirely, so
 * that's the only version implemented here.
 *
 * KNOWN GAP — drawer front attachment isn't modeled as a joint yet.
 * A drawer front's connection to its drawer box (matched via
 * drawerBoxFrontId, not a Joint or FeatureJoint) has no detector, the
 * same way door hinges and drawer slides didn't until
 * detectFeatureJoints was built for them. Until that's added, a
 * drawer front panel with no other structural joints shows up as its
 * own unattached step — flagged, not silently dropped (see `kind:
 * 'unattached'` below) — same philosophy as findOrphanPanels.
 */
import { resolveConstraints } from '../modeller/snap.js';
import { detectJoints, detectFeatureJoints } from './joints.js';
import { buildHardwarePlan } from './hardware.js';

const STRUCTURAL_JOINT_TYPES = new Set(['corner_butt', 't_butt', 'face_to_face']);

// ---------------------------------------------------------------
// Connected components over the STRUCTURAL graph only
// ---------------------------------------------------------------
function computeClusters(panelIds, structuralJoints) {
  const adjacency = new Map(panelIds.map((id) => [id, new Set()]));
  structuralJoints.forEach((j) => {
    adjacency.get(j.panelA)?.add(j.panelB);
    adjacency.get(j.panelB)?.add(j.panelA);
  });

  const visited = new Set();
  const clusters = [];
  panelIds.forEach((startId) => {
    if (visited.has(startId)) return;
    const cluster = new Set();
    const queue = [startId];
    visited.add(startId);
    while (queue.length > 0) {
      const id = queue.shift();
      cluster.add(id);
      adjacency.get(id)?.forEach((neighborId) => {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      });
    }
    clusters.push(cluster);
  });
  return clusters;
}

/**
 * @typedef {Object} AssemblyStep
 * @property {number} index - 1-based order in the final sequence
 * @property {'pre_install'|'join'|'integrate'|'unattached'} kind
 * @property {'prepare'|'subassembly'|'internal'|'closure'|'integration'|'unattached'} phase
 * @property {'flat'|'upright'|'rear_access'|'front_access'|'unknown'} orientation
 * @property {boolean} requiresReposition
 * @property {number} repositionCost
 * @property {string[]} panelIds
 * @property {string[]} otherPanelIds - for 'join': the already-placed panels this step's new panel connects to; empty for every other kind (an 'integrate' step's panelIds already lists every panel involved on both sides)
 * @property {string[]} panelNames
 * @property {string[]} panelCodes
 * @property {string[]} jointIds - underlying Joint/FeatureJoint ids realized by this step
 * @property {object[]} hardware - matching entries from buildHardwarePlan (hinges/runners/fasteners), if any
 * @property {string} description
 * @property {string} stepId - stable human-facing step identifier
 * @property {string} subassemblyId
 * @property {string} subassemblyName
 * @property {string} action - prepare/assemble/install/close/integrate/inspect
 * @property {string} instruction - human-readable primary instruction
 * @property {string[]} warnings
 * @property {string[]} prerequisiteStepIds
 * @property {boolean} subassemblyComplete
 */

/**
 * Builds a full assembly order for a design: sub-assemblies clustered
 * and internally ordered, hardware pre-installed before its panel's
 * first structural joint, integration steps (drawer insertion, door
 * hanging) scheduled only once both sides are complete, hinges always
 * last. Pure function — nothing persisted, safe to call fresh anytime,
 * same convention as buildJointsReport/buildHardwarePlan.
 *
 * @param {Array} panels - RAW graph (not resolved)
 * @returns {{ steps: AssemblyStep[], clusters: {panelIds:string[]}[] }}
 */

// ---------------------------------------------------------------
// Phase-1 semantic ordering helpers
// ---------------------------------------------------------------
function textOfPanel(panel) {
  return [panel?.name, panel?.pieceCode, panel?.code, panel?.type, panel?.role]
    .filter(Boolean).join(' ').toLowerCase();
}

function panelRole(panel) {
  if (!panel) return 'unknown';
  if (panel.isDoor) return 'door';
  if (panel.isDrawerFront) return 'drawer_front';
  if (panel.isDrawerBoxPanel) return 'drawer_box';
  if (panel.isBack || panel.role === 'back') return 'back';
  if (panel.isTop || panel.role === 'top') return 'top';
  if (panel.isBottom || panel.role === 'bottom') return 'bottom';
  if (panel.isVerticalDivider || panel.role === 'vertical_divider') return 'vertical';
  if (panel.isShelf || panel.role === 'horizontal_shelf') return 'horizontal';

  const t = textOfPanel(panel);
  if (/drawer[ _-]*(front|face)|front[ _-]*drawer/.test(t)) return 'drawer_front';
  if (/drawer[ _-]*(box|side)|drawer/.test(t) && /box|side/.test(t)) return 'drawer_box';
  if (/door/.test(t)) return 'door';
  if (/back|rear/.test(t)) return 'back';
  if (/top|upper|roof/.test(t)) return 'top';
  if (/bottom|base|plinth/.test(t)) return 'bottom';
  if (/vertical|divider|partition|upright|centre.?panel|center.?panel/.test(t)) return 'vertical';
  if (/shelf|shelves|horizontal|fixed.?shelf|adjustable.?shelf/.test(t)) return 'horizontal';
  return 'unknown';
}

function clusterRole(cluster, rawById) {
  const roles = [...cluster].map((id) => panelRole(rawById.get(id)));
  if (roles.every((r) => r === 'door')) return 'door';
  if (roles.every((r) => r === 'drawer_box')) return 'drawer_box';
  if (roles.every((r) => r === 'drawer_front')) return 'drawer_front';
  if (roles.includes('door')) return 'door';
  if (roles.includes('drawer_box')) return 'drawer_box';
  return 'carcass';
}

function desiredOrientation(role) {
  if (role === 'door' || role === 'drawer_box' || role === 'drawer_front') return 'flat';
  if (role === 'back') return 'rear_access';
  if (role === 'top') return 'upright';
  return 'flat';
}

function panelPriority(role) {
  return ({
    door: 10,
    drawer_box: 20,
    drawer_front: 25,
    bottom: 40,
    vertical: 50,
    horizontal: 60,
    unknown: 65,
    back: 90,
    top: 100,
  })[role] ?? 65;
}

function clusterPriority(role) {
  return ({ door: 10, drawer_box: 20, drawer_front: 25, carcass: 40 })[role] ?? 40;
}

function roleOfStepPanel(panelId, rawById) {
  return panelRole(rawById.get(panelId));
}


// ---------------------------------------------------------------
// Phase-2 ergonomic scoring
// ---------------------------------------------------------------
// Scores are deliberately heuristic and normalized to 0..10.  They are
// used only after hard structural/phase constraints have been respected.
// Lower is easier for a human assembler.
function clamp10(value) { return Math.max(0, Math.min(10, value)); }

function numericDimension(panel, keys) {
  for (const key of keys) {
    const value = Number(panel?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function panelErgonomicSize(panel, resolved) {
  const width = numericDimension(panel, ['width', 'w', 'lengthX']) || Number(resolved?.width) || 0;
  const height = numericDimension(panel, ['height', 'h', 'lengthY']) || Number(resolved?.height) || 0;
  const thickness = numericDimension(panel, ['thickness', 'depth', 'd']) || Number(resolved?.thickness) || 0;
  const area = width * height;
  const maxSpan = Math.max(width, height);
  return { width, height, thickness, area, maxSpan };
}

function ergonomicPanelMetrics(panel, resolved) {
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

function jointToolAccessScore(joints) {
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

function ergonomicStepScore({ panel, resolved, role, joints = [], orientation, fromOrientation, kind }) {
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

function ergonomicClusterScore(clusterIds, rawById, resolvedById) {
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

function orderClusterPanelsPhase1(clusterIds, structuralJoints, resolvedById, codeOf, rawById) {
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


// ---------------------------------------------------------------
// Phase-3 human-readable assembly model
// ---------------------------------------------------------------
function subassemblyLabel(role, ordinal) {
  if (role === 'door') return `Door assembly ${ordinal}`;
  if (role === 'drawer_box') return `Drawer assembly ${ordinal}`;
  if (role === 'drawer_front') return `Drawer front assembly ${ordinal}`;
  if (role === 'carcass') return ordinal === 1 ? 'Main carcass' : `Carcass assembly ${ordinal}`;
  return `Sub-assembly ${ordinal}`;
}

function actionForStep(kind, phase, role) {
  if (kind === 'pre_install') return 'prepare';
  if (kind === 'integrate') return 'integrate';
  if (kind === 'unattached') return 'inspect';
  if (phase === 'closure') return 'close';
  if (role === 'door' || role === 'drawer_box' || role === 'drawer_front') return 'assemble';
  return 'install';
}

function roleDisplay(role) {
  return ({
    door: 'door', drawer_box: 'drawer box', drawer_front: 'drawer front',
    back: 'back panel', top: 'top panel', bottom: 'bottom panel',
    vertical: 'vertical divider', horizontal: 'horizontal shelf',
  })[role] || 'component';
}

function humanInstruction({ kind, phase, role, panelCode, otherCodes, hardware, description }) {
  if (kind === 'pre_install') {
    const hw = hardware?.[0];
    const hwName = hw?.displayId || hw?.hardware?.series || hw?.hardware?.kind || 'hardware';
    return `Prepare ${panelCode}: install ${hwName} while the panel is separate and fully accessible.`;
  }
  if (kind === 'integrate') return description;
  if (kind === 'unattached') return `Identify ${panelCode} and set it aside; no assembly connection is currently modeled for this part.`;
  if (phase === 'closure' && role === 'back') return `Install ${panelCode} as the back panel after all accessible internal components are installed.`;
  if (phase === 'closure' && role === 'top') return `Install ${panelCode} as the top panel only after the internal assembly and back panel are complete.`;
  if (role === 'vertical') return `Install ${panelCode} as the vertical divider before installing the top panel.`;
  if (role === 'horizontal') return `Install ${panelCode} as a horizontal shelf before closing the rear with the back panel.`;
  if (kind === 'join' && otherCodes?.length) return `Attach ${panelCode} to ${otherCodes.join(', ')}.`;
  return description;
}

function warningsForStep({ kind, phase, role }) {
  const warnings = [];
  if (role === 'door') {
    warnings.push('Build the door flat before hanging it on the carcass.');
    if (kind === 'integrate') warnings.push('Support the door while connecting the pre-fitted hinges.');
  }
  if (role === 'drawer_box') warnings.push('Complete the drawer box before inserting it into the carcass.');
  if (role === 'vertical') warnings.push('Install vertical dividers before the top panel closes access.');
  if (role === 'horizontal') warnings.push('Install horizontal shelves before the back panel closes rear access.');
  if (role === 'back') warnings.push('Do not install the back until all required internal components are in place.');
  if (role === 'top') warnings.push('Do not install the top until the internal components and back panel are complete.');
  if (kind === 'pre_install') warnings.push('Keep the panel separate while fitting this hardware.');
  return [...new Set(warnings)];
}

function orientationInstruction(orientation) {
  return ({
    flat: 'Work with the component flat on a supported surface.',
    rear_access: 'Keep the rear/open face accessible for this operation.',
    front_access: 'Keep the front face accessible for this operation.',
    upright: 'Work with the furniture upright and stable.',
    unknown: 'Use the orientation that keeps the joint and tool access clear.',
  })[orientation] || '';
}

function finalizeHumanReadableModel(steps) {
  // Completion means the independent build is finished, not that the
  // later integration step has happened. Keep integration out of this map.
  const lastBuildStepBySubassembly = new Map();
  steps.forEach((step) => {
    if (step.subassemblyId && step.action !== 'integrate') {
      lastBuildStepBySubassembly.set(step.subassemblyId, step);
    }
  });

  steps.forEach((step) => {
    step.stepId = `S${String(step.index).padStart(2, '0')}`;
    step.prerequisiteStepIds = [];
    const warnings = [...(step.warnings || [])];

    if (step.action === 'integrate' && step.subassemblyId) {
      // Integration depends on the completion of the participating subassemblies.
      const ids = step.integrationSubassemblyIds || [];
      ids.forEach((id) => {
        const last = lastBuildStepBySubassembly.get(id);
        if (last && last.stepId !== step.stepId) step.prerequisiteStepIds.push(last.stepId);
      });
    }

    if (step.role === 'back') {
      const priorInternal = steps.filter((s) => s.index < step.index && s.phase === 'internal');
      if (priorInternal.length) step.prerequisiteStepIds.push(priorInternal[priorInternal.length - 1].stepId);
    }
    if (step.role === 'top') {
      const priorClosure = steps.filter((s) => s.index < step.index && (s.role === 'back' || s.phase === 'internal'));
      if (priorClosure.length) step.prerequisiteStepIds.push(priorClosure[priorClosure.length - 1].stepId);
    }

    step.prerequisiteStepIds = [...new Set(step.prerequisiteStepIds)];
    step.orientationInstruction = orientationInstruction(step.orientation);
    step.warnings = [...new Set(warnings)];
  });

  // Mark the last action in each independent subassembly. This gives the PDF
  // renderer a clean "finish and set aside" boundary without inventing one.
  lastBuildStepBySubassembly.forEach((step) => {
    if (step.phase === 'subassembly' || step.phase === 'prepare') {
      step.subassemblyComplete = true;
      if (step.action !== 'integrate') {
        step.completionInstruction = `Sub-assembly complete: ${step.subassemblyName}. Set it aside until final integration.`;
      }
    }
  });
  return steps;
}

export function buildAssemblySequence(panels) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const nameById = new Map(resolved.map((r) => [r.id, r.name || r.id]));
  const pieceCodeById = new Map(panels.map((p) => [p.id, p.pieceCode]));
  const codeOf = (id) => pieceCodeById.get(id) ?? nameById.get(id) ?? id;

  const { joints } = detectJoints(resolved);
  const featureJoints = detectFeatureJoints(panels);
  const hardwarePlan = buildHardwarePlan(panels);

  // A closed door, or a drawer box sized to fit snugly in its opening,
  // is often geometrically FLUSH against panels it merely rests near
  // (zero reveal gap against the carcass Top/Bottom/Back, say) — which
  // detectJoints correctly classifies as a real corner_butt/t_butt/
  // face_to_face contact, but that contact is incidental to the
  // panel's position, not a screw connection. The only real mechanical
  // links for these panels are their FeatureJoints (door_hinge /
  // drawer_slide — see engine/joints.js) plus, for a drawer box, its
  // OWN internal joints to its own sibling panels (which ARE real
  // screwed connections). Without this filter, a door or drawer box
  // would wrongly get clustered into the same rigid sub-assembly as
  // the carcass it merely sits against, "assembled" via confirmat
  // screws that don't exist. This is the same "geometric contact !=
  // physical connection" distinction the whole joints/hardware
  // architecture was built around — just showing up in a place
  // detectJoints/buildHardwarePlan don't currently guard against
  // themselves (a latent inaccuracy in their own fastener suggestions
  // for a door or a snug drawer box, worth fixing there too — flagged,
  // not fixed here, to keep this file's own scope to sequencing).
  const rawById = new Map(panels.map((p) => [p.id, p]));
  const isSameRigidUnit = (aId, bId) => {
    const a = rawById.get(aId);
    const b = rawById.get(bId);
    if (!a || !b) return true;
    if (a.isDoor || b.isDoor) return false; // a door never rigidly joins anything — only its hinge FeatureJoint is real
    if (a.isDrawerFront || b.isDrawerFront) return false; // front attachment isn't modeled as a joint yet — see this file's known-gap note
    if (a.isDrawerBoxPanel || b.isDrawerBoxPanel) {
      // A drawer box's OWN corners are real joints; contact with
      // anything outside its own drawer (the carcass, another drawer)
      // is incidental, not structural.
      return a.isDrawerBoxPanel && b.isDrawerBoxPanel && a.drawerBoxFrontId === b.drawerBoxFrontId;
    }
    return true; // ordinary carcass/shelf panels
  };
  const structuralJoints = joints.filter((j) => STRUCTURAL_JOINT_TYPES.has(j.type) && isSameRigidUnit(j.panelA, j.panelB));
  const integrationPanelIds = new Set(featureJoints.flatMap((j) => [j.panelA, j.panelB]));
  const visiblePanelIds = resolved.filter((p) => !p.hidden).map((p) => p.id);
  const clusters = computeClusters(visiblePanelIds, structuralJoints);

  // pre-install hardware, keyed by which panel it must precede
  const preInstallByPanel = new Map(); // panelId -> hardwarePlan entry[]
  const addPreInstall = (panelId, entry) => {
    if (!preInstallByPanel.has(panelId)) preInstallByPanel.set(panelId, []);
    preInstallByPanel.get(panelId).push(entry);
  };
  hardwarePlan.hinges.forEach((h) => {
    addPreInstall(h.panelA, h); // the door itself
    addPreInstall(h.panelB, h); // the carcass boundary panel's mounting plate — see file header's unification note
  });
  hardwarePlan.runners.forEach((r) => {
    addPreInstall(r.panelA, r); // drawer box side
    addPreInstall(r.panelB, r); // carcass side bracket
  });

  const steps = [];
  let stepIndex = 1;
  const pushStep = (partial) => {
    const primaryId = partial.panelIds?.[0];
    const sub = primaryId ? clusterOfPanel.get(primaryId) : null;
    const role = partial.role ?? roleOfStepPanel(primaryId, rawById);
    const index = stepIndex++;
    const panelCodes = partial.panelIds.map((id) => codeOf(id));
    const instruction = partial.instruction ?? humanInstruction({
      kind: partial.kind, phase: partial.phase, role,
      panelCode: panelCodes[0], otherCodes: partial.otherPanelIds?.map(codeOf) || [],
      hardware: partial.hardware, description: partial.description,
    });
    steps.push({
      index,
      stepId: `S${String(index).padStart(2, '0')}`,
      panelNames: partial.panelIds.map((id) => nameById.get(id) ?? '?'),
      panelCodes,
      role,
      action: partial.action ?? actionForStep(partial.kind, partial.phase, role),
      subassemblyId: partial.subassemblyId ?? sub?.id ?? null,
      subassemblyName: partial.subassemblyName ?? sub?.name ?? null,
      instruction,
      warnings: [...new Set([...(partial.warnings || []), ...warningsForStep({ kind: partial.kind, phase: partial.phase, role })])],
      prerequisiteStepIds: partial.prerequisiteStepIds || [],
      subassemblyComplete: false,
      ...partial,
      // Keep the derived human-readable fields authoritative after spreading partial.
      stepId: `S${String(index).padStart(2, '0')}`,
      role,
      action: partial.action ?? actionForStep(partial.kind, partial.phase, role),
      subassemblyId: partial.subassemblyId ?? sub?.id ?? null,
      subassemblyName: partial.subassemblyName ?? sub?.name ?? null,
      instruction,
      warnings: [...new Set([...(partial.warnings || []), ...warningsForStep({ kind: partial.kind, phase: partial.phase, role })])],
      prerequisiteStepIds: partial.prerequisiteStepIds || [],
      subassemblyComplete: false,
    });
  };

  // -----------------------------------------------------------------
  // Phase 1 ordering strategy
  // -----------------------------------------------------------------
  // Independent sub-assemblies first; then the main carcass; within the
  // carcass: bottom -> vertical -> horizontal -> back -> top.
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
  const subassemblyById = new Map();
  clusterList.forEach(({ ids, id, role, name }) => {
    const meta = { id, role, name };
    subassemblyById.set(id, meta);
    ids.forEach((panelId) => clusterOfPanel.set(panelId, { ids, ...meta }));
  });

  let assemblyOrientation = 'flat';
  const repositionCostBetween = (from, to) => {
    if (!from || !to || from === to || from === 'unknown' || to === 'unknown') return 0;
    return 1;
  };

  const emitStep = (partial) => {
    const primaryId = partial.panelIds?.[0];
    const primaryPanel = rawById.get(primaryId);
    const primaryResolved = resolvedById.get(primaryId);
    const primaryRole = roleOfStepPanel(primaryId, rawById);
    const orientation = partial.orientation ?? desiredOrientation(primaryRole);
    const repositionCost = repositionCostBetween(assemblyOrientation, orientation);
    const requiresReposition = repositionCost > 0;
    const ergonomic = ergonomicStepScore({
      panel: primaryPanel,
      resolved: primaryResolved,
      role: primaryRole,
      joints: partial.jointObjects ?? [],
      orientation,
      fromOrientation: assemblyOrientation,
      kind: partial.kind,
    });
    ergonomic.reposition = Math.max(ergonomic.reposition, repositionCost * 2);
    ergonomic.score = Math.round((ergonomic.score + repositionCost * 4) * 10) / 10;
    if (orientation !== 'unknown') assemblyOrientation = orientation;
    const primarySubassembly =
      primaryId != null
        ? clusterOfPanel.get(primaryId)
        : null;

    pushStep({
      phase:
        partial.phase ??
        (
          partial.kind === 'integrate'
            ? 'integration'
            : partial.kind === 'pre_install'
              ? 'prepare'
              : 'subassembly'
        ),

      orientation,
      requiresReposition,
      repositionCost,
      ergonomic,

      subassemblyId:
        partial.subassemblyId ??
        primarySubassembly?.id ??
        null,

      subassemblyName:
        partial.subassemblyName ??
        primarySubassembly?.name ??
        null,

      clusterKind:
        partial.clusterKind ??
        primarySubassembly?.role ??
        null,

      ...partial,
    });
  };

  clusterList.forEach(({ order, id: subassemblyId, name: subassemblyName, role: clusterKind }) => {
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
        const hasKnownFutureRole = pre || integrationPanelIds.has(newPanel);
        let description;
        if (clusterHasOtherPanels) {
          description = `Start the ${role === 'door' ? 'door' : role === 'drawer_box' ? 'drawer' : 'sub-assembly'} with ${codeOf(newPanel)}.`;
        } else if (hasKnownFutureRole) {
          description = `Prepare ${codeOf(newPanel)} and set it aside ready for final integration.`;
        } else {
          description = `Place ${codeOf(newPanel)} — no structural joint or hardware association found for it yet (see the known-gap note).`;
        }
        emitStep({
          kind: clusterHasOtherPanels || hasKnownFutureRole ? 'join' : 'unattached',
          phase: clusterHasOtherPanels || hasKnownFutureRole ? (role === 'door' || role === 'drawer_box' ? 'subassembly' : 'internal') : 'unattached',
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
  });

  // --- Integration phase: drawer insertions, then hinges last ------

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

  const hingeJoints = featureJoints.filter((j) => j.kind === 'door_hinge');
  hingeJoints.forEach((j) => {
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

  finalizeHumanReadableModel(steps);

  return {
    steps,
    clusters: clusterList.map(({ ids, id, role, name }) => ({
      id, role, name, panelIds: [...ids],
    })),
    phases: [
      { id: 'prepare', name: 'Prepare components' },
      { id: 'subassembly', name: 'Build independent sub-assemblies' },
      { id: 'internal', name: 'Build internal carcass components' },
      { id: 'closure', name: 'Close the carcass' },
      { id: 'integration', name: 'Final integration' },
    ],
  };
}

/**
 * Plain-text rendering of a sequence. Includes Phase-2 ergonomic metrics and
 * orientation annotations so the ordering can be inspected before any
 * PDF/visual work is added.
 *
 * @param {ReturnType<typeof buildAssemblySequence>} sequence
 * @returns {string[]}
 */
export function formatAssemblySequenceLines(sequence) {
  return sequence.steps.map((s) => {
    const hwSuffix = s.hardware.length > 0 ? `  [hardware: ${s.hardware.map((h) => h.displayId).join(', ')}]` : '';
    const e = s.ergonomic;
    const ergoSuffix = e ? `  [ergo ${e.score}/100; reach ${e.reach}, tool ${e.toolAccess}, support ${e.support}, weight ${e.weight}, posture ${e.posture}, 2P ${e.twoPerson}]` : '';
    const state = ` [${s.phase}; ${s.action}; ${s.orientation}${s.requiresReposition ? '; reposition' : ''}]`;
    const sub = s.subassemblyName ? ` [${s.subassemblyName}]` : '';
    const prereq = s.prerequisiteStepIds?.length ? ` [after ${s.prerequisiteStepIds.join(', ')}]` : '';
    const warning = s.warnings?.length ? ` [warning: ${s.warnings.join(' | ')}]` : '';
    const complete = s.subassemblyComplete ? ` [COMPLETE: ${s.completionInstruction}]` : '';
    return `${s.stepId}. ${sub}${state}${prereq}  ${s.instruction || s.description}${warning}${complete}${hwSuffix}${ergoSuffix}`;
  });
}

// ===============================================================
// PHASE 4 — HUMAN-FIRST PDF / UI PRESENTATION LAYER
// ===============================================================
//
// This layer intentionally does NOT change assembly sequencing.
// It consumes the Phase-3 human-readable assembly model and turns it
// into a PDF-friendly document model and a self-contained printable HTML
// manual. The HTML can be printed directly to PDF by the host application.
//
// Design goals:
//   - one clear action per step;
//   - persistent phase/progress indicator;
//   - large visual action area;
//   - parts/hardware shown at point of use;
//   - warnings visually separated from instructions;
//   - orientation shown explicitly;
//   - subassembly completion clearly visible;
//   - final integration and adjustment separated from construction;
//   - minimal text density and generous touch/print spacing.
//
// The renderer accepts optional `diagramHtml` / `diagramSvg` fields on
// steps. If the existing geometry/PDF layer can provide those later, they
// are placed into the large diagram area without changing this UI model.
// ===============================================================

const PHASE4_PHASES = [
  {
    id: 'prepare',
    label: 'Prepare',
    shortLabel: 'PREP',
  },
  {
    id: 'subassembly',
    label: 'Sub-assemblies',
    shortLabel: 'BUILD',
  },
  {
    id: 'internal',
    label: 'Internal',
    shortLabel: 'INTERNAL',
  },
  {
    id: 'closure',
    label: 'Close carcass',
    shortLabel: 'CLOSE',
  },
  {
    id: 'integration',
    label: 'Final integration',
    shortLabel: 'INTEGRATE',
  },
];

function phase4EscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function phase4Array(value) {
  return Array.isArray(value) ? value : [];
}

function phase4Unique(values) {
  return [...new Set(
    phase4Array(values).filter(Boolean)
  )];
}

function phase4PhaseIndex(phase) {
  const index = PHASE4_PHASES.findIndex(
    (p) => p.id === phase
  );

  return index < 0 ? 0 : index;
}

function phase4ActionLabel(action) {
  return ({
    prepare: 'PREPARE',
    assemble: 'ASSEMBLE',
    install: 'INSTALL',
    close: 'CLOSE',
    integrate: 'PLUG IN',
    inspect: 'CHECK',
  })[action] || String(action || 'DO');
}

function phase4OrientationLabel(orientation) {
  return ({
    flat: 'WORK FLAT',
    rear_access: 'KEEP REAR ACCESSIBLE',
    front_access: 'KEEP FRONT ACCESSIBLE',
    upright: 'WORK UPRIGHT',
    unknown: 'KEEP ACCESS CLEAR',
  })[orientation] || 'KEEP ACCESS CLEAR';
}

function phase4OrientationIcon(orientation) {
  return ({
    flat: '▱',
    rear_access: '↙',
    front_access: '↗',
    upright: '▯',
    unknown: '◇',
  })[orientation] || '◇';
}

function phase4ErgonomicLabel(score) {
  if (!Number.isFinite(score)) return '—';
  if (score <= 25) return 'Easy';
  if (score <= 45) return 'Moderate';
  if (score <= 65) return 'Careful';
  return 'Difficult';
}

function phase4BuildVisualParts(
  options = {}
) {
  const rawPanels =
    phase4Array(
      options.panels
    );

  const resolvedPanels =
    phase4Array(
      options.resolvedPanels
    );

  const resolvedById =
    new Map(
      resolvedPanels.map(
        (panel) => [
          panel.id,
          panel,
        ]
      )
    );

  return rawPanels.map(
    (panel) => {

      const resolved =
        resolvedById.get(
          panel.id
        );

      const dimensions =
        phase4PanelDimensions(
          panel,
          resolved
        );

      const role =
        panelRole(panel);

      return {
        id: panel.id,

        code:
          panel.pieceCode ??
          panel.code ??
          resolved?.pieceCode ??
          panel.id,

        name:
          panel.name ??
          resolved?.name ??
          panel.id,

        role,

        roleLabel:
          phase4RoleLabel(role),

        width:
          dimensions.width,

        height:
          dimensions.height,

        thickness:
          dimensions.thickness,
      };
    }
  );
}

function phase4BuildAssemblyStateSvg(
  step,
  allParts
) {
  const parts =
    phase4Array(allParts);

  if (parts.length === 0) {
    return '';
  }

  const placedIds =
    new Set(
      phase4Array(
        step.placedPanelIds
      )
    );

  const newIds =
    new Set(
      phase4Array(
        step.panelIds
      )
    );

  /*
   * Determine a common furniture envelope.
   * Dimensions are kept in the model's native units.
   */
  const carcass =
    parts.filter(
      (part) =>
        ![
          'door',
          'drawer_box',
          'drawer_front',
        ].includes(part.role)
    );

  const widths =
    carcass
      .map((p) => p.width)
      .filter((v) => v > 0);

  const heights =
    carcass
      .map((p) => p.height)
      .filter((v) => v > 0);

  const furnitureWidth =
    Math.max(
      ...widths,
      1000
    );

  const furnitureHeight =
    Math.max(
      ...heights,
      1000
    );

  const viewWidth = 700;
  const viewHeight = 500;

  const margin = 55;

  const scale =
    Math.min(
      (viewWidth - margin * 2) /
        furnitureWidth,

      (viewHeight - margin * 2) /
        furnitureHeight
    );

  const cabinetWidth =
    furnitureWidth * scale;

  const cabinetHeight =
    furnitureHeight * scale;

  const cabinetX =
    (viewWidth - cabinetWidth) / 2;

  const cabinetY =
    (viewHeight - cabinetHeight) / 2;

  const placed =
    parts.filter(
      (part) =>
        placedIds.has(part.id)
    );

  const svgParts = [];

  /*
   * Draw the carcass envelope first.
   */
  svgParts.push(`
    <rect
      x="${cabinetX.toFixed(2)}"
      y="${cabinetY.toFixed(2)}"
      width="${cabinetWidth.toFixed(2)}"
      height="${cabinetHeight.toFixed(2)}"
      fill="none"
      stroke="#b8b8b8"
      stroke-width="1"
      stroke-dasharray="5 5"
    />
  `);

  /*
   * Assign furniture positions by semantic role.
   *
   * The panel's OWN dimensions are always used
   * for its rectangle, so relative proportions
   * remain correct.
   */
  const bottomParts =
    placed.filter(
      (p) => p.role === 'bottom'
    );

  const topParts =
    placed.filter(
      (p) => p.role === 'top'
    );

  const verticalParts =
    placed.filter(
      (p) => p.role === 'vertical'
    );

  const shelfParts =
    placed.filter(
      (p) => p.role === 'horizontal'
    );

  const backParts =
    placed.filter(
      (p) => p.role === 'back'
    );

  const doors =
    placed.filter(
      (p) =>
        p.role === 'door'
    );

  const drawers =
    placed.filter(
      (p) =>
        p.role === 'drawer_box' ||
        p.role === 'drawer_front'
    );

  const drawPanel = (
    part,
    x,
    y,
    width,
    height,
    extraClass = ''
  ) => {

    const isNew =
      newIds.has(part.id);

    const fill =
      isNew
        ? '#d9d9d9'
        : '#eeeeea';

    const stroke =
      isNew
        ? '#111'
        : '#777';

    const strokeWidth =
      isNew
        ? 3
        : 1.5;

    const label =
      phase4EscapeHtml(
        part.code
      );

    svgParts.push(`
      <g class="p4-assembly-panel ${extraClass}">
        <rect
          x="${x.toFixed(2)}"
          y="${y.toFixed(2)}"
          width="${Math.max(width, 3).toFixed(2)}"
          height="${Math.max(height, 3).toFixed(2)}"
          fill="${fill}"
          stroke="${stroke}"
          stroke-width="${strokeWidth}"
          rx="1"
        />

        <text
          x="${(x + width / 2).toFixed(2)}"
          y="${(y + height / 2 + 3).toFixed(2)}"
          text-anchor="middle"
          font-size="11"
          font-weight="700"
          fill="#111"
        >
          ${label}
        </text>
      </g>
    `);
  };

  /*
   * Bottom.
   */
  bottomParts.forEach(
    (part) => {
      const width =
        Math.min(
          cabinetWidth,
          part.width * scale
        );

      const height =
        Math.max(
          6,
          part.height * scale
        );

      drawPanel(
        part,
        cabinetX,
        cabinetY +
          cabinetHeight -
          height,
        width,
        height,
        'bottom'
      );
    }
  );

  /*
   * Top.
   */
  topParts.forEach(
    (part) => {
      const width =
        Math.min(
          cabinetWidth,
          part.width * scale
        );

      const height =
        Math.max(
          6,
          part.height * scale
        );

      drawPanel(
        part,
        cabinetX,
        cabinetY,
        width,
        height,
        'top'
      );
    }
  );

  /*
   * Vertical dividers.
   */
  verticalParts.forEach(
    (part, index) => {

      const width =
        Math.max(
          5,
          part.width * scale
        );

      const height =
        Math.min(
          cabinetHeight,
          part.height * scale
        );

      const usable =
        cabinetWidth - width;

      const x =
        cabinetX +
        (
          usable *
          ((index + 1) /
            (verticalParts.length + 1))
        );

      const y =
        cabinetY +
        (cabinetHeight - height) / 2;

      drawPanel(
        part,
        x,
        y,
        width,
        height,
        'vertical'
      );
    }
  );

  /*
   * Shelves.
   */
  shelfParts.forEach(
    (part, index) => {

      const width =
        Math.min(
          cabinetWidth,
          part.width * scale
        );

      const height =
        Math.max(
          5,
          part.height * scale
        );

      const usable =
        cabinetHeight -
        height;

      const y =
        cabinetY +
        usable *
        (
          (index + 1) /
          (shelfParts.length + 1)
        );

      drawPanel(
        part,
        cabinetX,
        y,
        width,
        height,
        'shelf'
      );
    }
  );

  /*
   * Back panel.
   *
   * Drawn behind the internal parts.
   */
  backParts.forEach(
    (part) => {

      const width =
        Math.min(
          cabinetWidth,
          part.width * scale
        );

      const height =
        Math.min(
          cabinetHeight,
          part.height * scale
        );

      drawPanel(
        part,
        cabinetX,
        cabinetY,
        width,
        height,
        'back'
      );
    }
  );

  /*
   * Doors.
   */
  doors.forEach(
    (part, index) => {

      const width =
        Math.max(
          8,
          part.width * scale
        );

      const height =
        Math.max(
          10,
          part.height * scale
        );

      const x =
        cabinetX +
        cabinetWidth +
        18 +
        index *
        (width + 8);

      const y =
        cabinetY +
        (
          cabinetHeight -
          height
        ) / 2;

      drawPanel(
        part,
        x,
        y,
        width,
        height,
        'door'
      );
    }
  );

  /*
   * Drawers.
   */
  drawers.forEach(
    (part, index) => {

      const width =
        Math.max(
          20,
          part.width * scale
        );

      const height =
        Math.max(
          10,
          part.height * scale
        );

      const x =
        cabinetX +
        (
          cabinetWidth -
          width
        ) / 2;

      const y =
        cabinetY +
        cabinetHeight +
        15 +
        index *
        (height + 7);

      drawPanel(
        part,
        x,
        y,
        width,
        height,
        'drawer'
      );
    }
  );

  return `
    <svg
      class="p4-assembly-state"
      viewBox="0 0 ${viewWidth} ${viewHeight}"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Assembly state at this step"
    >
      ${svgParts.join('')}

      <text
        x="${viewWidth / 2}"
        y="25"
        text-anchor="middle"
        font-size="13"
        font-weight="800"
        fill="#666"
      >
        ASSEMBLY STATE
      </text>

      <text
        x="${viewWidth / 2}"
        y="${viewHeight - 12}"
        text-anchor="middle"
        font-size="10"
        fill="#777"
      >
        New panels are emphasized
      </text>
    </svg>
  `;
}

function phase4StepDiagram(step) {
  if (step.diagramHtml) {
    return step.diagramHtml;
  }

  if (step.diagramSvg) {
    return step.diagramSvg;
  }

  const panelCodes = phase4Unique([
    ...(step.panelCodes || []),
    ...(step.otherPanelIds || []),
  ]);

  const primary =
    phase4EscapeHtml(
      panelCodes[0] || 'PART'
    );

  const secondary =
    phase4EscapeHtml(
      panelCodes.slice(1, 4).join(' + ')
    );

  const action =
    phase4EscapeHtml(
      phase4ActionLabel(step.action)
    );

  return `
    <div class="p4-diagram-fallback" aria-label="Assembly diagram placeholder">
      <div class="p4-diagram-panel p4-diagram-panel-main">
        <span>${primary}</span>
      </div>
      <div class="p4-diagram-arrow">↓</div>
      <div class="p4-diagram-target">
        <span>${secondary || 'ASSEMBLY'}</span>
      </div>
      <div class="p4-diagram-action">${action}</div>
    </div>
  `;
}

function phase4Warnings(step) {
  return phase4Unique(
    step.warnings || []
  );
}

function phase4Hardware(step) {
  return phase4Array(step.hardware)
    .map((hardware) => {
      return (
        hardware.displayId ||
        hardware.id ||
        hardware.hardware?.series ||
        hardware.hardware?.kind ||
        'Hardware'
      );
    })
    .filter(Boolean);
}

function phase4Parts(step) {
  return phase4Unique([
    ...(step.panelCodes || []),
    ...(step.panelNames || []),
  ]);
}

function phase4BuildProgress(steps, currentIndex) {
  const currentStep = steps[currentIndex];
  const currentPhase =
    currentStep?.phase || 'prepare';

  const phaseIndex =
    phase4PhaseIndex(currentPhase);

  return PHASE4_PHASES.map(
    (phase, index) => ({
      ...phase,
      index,
      state:
        index < phaseIndex
          ? 'complete'
          : index === phaseIndex
            ? 'current'
            : 'future',
    })
  );
}

function phase4BuildSubassemblySummary(sequence) {
  const map = new Map();

  phase4Array(sequence?.steps).forEach(
    (step) => {
      if (!step.subassemblyId) return;

      if (!map.has(step.subassemblyId)) {
        map.set(step.subassemblyId, {
          id: step.subassemblyId,
          name:
            step.subassemblyName ||
            step.subassemblyId,
          role:
            step.clusterKind ||
            'assembly',
          panelCodes: new Set(),
          stepIds: [],
          complete: false,
          integrated: false,
        });
      }

      const item = map.get(
        step.subassemblyId
      );

      phase4Array(step.panelCodes).forEach(
        (code) => item.panelCodes.add(code)
      );

      item.stepIds.push(step.stepId);

      if (step.subassemblyComplete) {
        item.complete = true;
      }

      if (step.action === 'integrate') {
        item.integrated = true;
      }
    }
  );

  return [...map.values()].map((item) => ({
    ...item,
    panelCodes: [...item.panelCodes],
  }));
}

function phase4NumericDimension(
  value
) {
  const n = Number(value);

  return Number.isFinite(n) && n > 0
    ? n
    : 0;
}


function phase4PanelDimensions(
  panel,
  resolved
) {
  const width =
    phase4NumericDimension(
      panel?.width
    ) ||
    phase4NumericDimension(
      panel?.w
    ) ||
    phase4NumericDimension(
      panel?.lengthX
    ) ||
    phase4NumericDimension(
      resolved?.width
    );

  const height =
    phase4NumericDimension(
      panel?.height
    ) ||
    phase4NumericDimension(
      panel?.h
    ) ||
    phase4NumericDimension(
      panel?.lengthY
    ) ||
    phase4NumericDimension(
      resolved?.height
    );

  const thickness =
    phase4NumericDimension(
      panel?.thickness
    ) ||
    phase4NumericDimension(
      panel?.depth
    ) ||
    phase4NumericDimension(
      panel?.d
    ) ||
    phase4NumericDimension(
      resolved?.thickness
    );

  return {
    width,
    height,
    thickness,
  };
}


function phase4RoleLabel(
  role
) {
  return ({
    bottom: 'Bottom',
    vertical: 'Vertical divider',
    horizontal: 'Shelf',
    back: 'Back',
    top: 'Top',
    door: 'Door',
    drawer_box: 'Drawer box',
    drawer_front: 'Drawer front',
    unknown: 'Panel',
  })[role] || 'Panel';
}

function phase4BuildPartsSummary(
  sequence,
  options = {}
) {
  const parts = new Map();

  const rawPanels = phase4Array(
    options.panels
  );

  const resolvedPanels = phase4Array(
    options.resolvedPanels
  );

  const resolvedById =
    new Map(
      resolvedPanels.map(
        (panel) => [panel.id, panel]
      )
    );

  const steps =
    phase4Array(sequence?.steps);

  /*
   * First source of truth:
   * the actual model panels.
   *
   * This ensures that EVERY panel appears,
   * even if a panel does not happen to be
   * represented by a structural assembly step.
   */
  rawPanels.forEach((panel) => {
    if (!panel?.id) return;

    const resolved =
      resolvedById.get(panel.id);

    const role =
      panelRole(panel);

    const dimensions =
      phase4PanelDimensions(
        panel,
        resolved
      );

    parts.set(panel.id, {
      id: panel.id,

      code:
        panel.pieceCode ??
        panel.code ??
        resolved?.pieceCode ??
        panel.id,

      name:
        panel.name ??
        resolved?.name ??
        panel.id,

      role,

      roleLabel:
        phase4RoleLabel(role),

      subassembly:
        null,

      width:
        dimensions.width,

      height:
        dimensions.height,

      thickness:
        dimensions.thickness,

      area:
        dimensions.width *
        dimensions.height,

      aspectRatio:
        dimensions.height > 0
          ? dimensions.width /
            dimensions.height
          : 1,
    });
  });

  /*
   * Add subassembly information from the
   * actual assembly sequence.
   */
  steps.forEach((step) => {

    const subassembly =
      step.subassemblyName ||
      null;

    phase4Array(
      step.panelIds
    ).forEach((id) => {

      const part =
        parts.get(id);

      if (!part) return;

      if (
        !part.subassembly &&
        subassembly
      ) {
        part.subassembly =
          subassembly;
      }
    });
  });

  return [...parts.values()];
}

function phase4BuildHardwareSummary(sequence) {
  const hardware = new Map();

  phase4Array(sequence?.steps).forEach(
    (step) => {
      phase4Array(step.hardware).forEach(
        (entry) => {
          const id =
            entry.displayId ||
            entry.id ||
            entry.hardware?.series ||
            entry.hardware?.kind ||
            'hardware';

          if (!hardware.has(id)) {
            hardware.set(id, {
              id,
              uses: [],
              count: 0,
            });
          }

          const item = hardware.get(id);
          item.count += 1;
          item.uses.push(step.stepId);
        }
      );
    }
  );

  return [...hardware.values()];
}

/**
 * Build the Phase-4 presentation model.
 *
 * This is deliberately renderer-neutral. A native PDF renderer can consume
 * it directly, while the bundled HTML renderer below provides an immediate
 * print-to-PDF implementation.
 */
export function buildAssemblyManualModel(
  sequence,
  options = {}
) {
  const steps = phase4Array(sequence?.steps);

  const title =
    options.title ||
    options.furnitureName ||
    'Furniture Assembly Manual';

  const subtitle =
    options.subtitle ||
    'Human-first assembly instructions';

  const toolNames = phase4Unique(
    options.tools || [
      'Screwdriver',
      'Assembly surface',
    ]
  );

  const placedPanelIds = new Set();
  const stepModels = steps.map(
    (step, index) => {

      const currentPanelIds =
        phase4Unique(
          step.panelIds
        );

      /*
      * Snapshot of the furniture immediately
      * AFTER this step.
      */
      const placedAfterStep = [
        ...new Set([
          ...placedPanelIds,
          ...currentPanelIds,
        ]),
      ];

      const visualParts =
        phase4BuildVisualParts(
          options
        );

      const assemblyStateSvg =
        phase4BuildAssemblyStateSvg(
          {
            ...step,
            placedPanelIds:
              placedAfterStep,
          },
          visualParts
        );

      /*
      * Update only after taking the snapshot,
      * so the step can still distinguish the
      * newly added panel(s).
      */
      currentPanelIds.forEach(
        (id) =>
          placedPanelIds.add(id)
      );
      const warnings =
        phase4Warnings(step);

      const hardware =
        phase4Hardware(step);

      const parts =
        phase4Parts(step);

      const progress =
        phase4BuildProgress(
          steps,
          index
        );

      const ergonomicScore =
        Number(step.ergonomic?.score);

      return {
        ...step,

        displayNumber:
          index + 1,

        totalSteps:
          steps.length,

        phaseIndex:
          phase4PhaseIndex(
            step.phase
          ),

        phaseLabel:
          PHASE4_PHASES[
            phase4PhaseIndex(
              step.phase
            )
          ]?.label ||
          step.phase ||
          'Assembly',

        actionLabel:
          phase4ActionLabel(
            step.action
          ),

        orientationLabel:
          phase4OrientationLabel(
            step.orientation
          ),

        orientationIcon:
          phase4OrientationIcon(
            step.orientation
          ),

        ergonomicLabel:
          phase4ErgonomicLabel(
            ergonomicScore
          ),

        warnings,
        hardware,
        parts,
        progress,

        diagramHtml:
          phase4StepDiagram(step),

        hasWarnings:
          warnings.length > 0,

        hasHardware:
          hardware.length > 0,

        hasPrerequisites:
          phase4Array(
            step.prerequisiteStepIds
          ).length > 0,

        isSubassemblyCompletion:
          Boolean(
            step.subassemblyComplete
          ),

        isIntegration:
          step.action === 'integrate',

        isClosure:
          step.phase === 'closure',
      };
    }
  );

  return {
    version: 'phase4',

    title,

    subtitle,

    metadata: {
      estimatedTime:
        options.estimatedTime || null,

      people:
        options.people || '1–2',

      tools:
        toolNames,

      safety:
        options.safety ||
        'Assemble on a stable, protected surface. Support large panels when required.',
    },

    phases:
      PHASE4_PHASES,

    parts:
      phase4BuildPartsSummary(
        sequence,
        options
      ),

    hardware:
      phase4BuildHardwareSummary(
        sequence
      ),

    subassemblies:
      phase4BuildSubassemblySummary(
        sequence
      ),

    visualPanels:
      phase4Array(
        options.panels
      ),

    resolvedPanels:
      phase4Array(
        options.resolvedPanels
      ),

    steps:
      stepModels,

    finalChecklist: [
      'Check that all structural fasteners are tightened.',
      'Confirm doors and drawers move freely.',
      'Adjust door gaps and fronts if required.',
      'Confirm the furniture is stable and level.',
      'Verify no hardware or loose parts remain unused.',
    ],
  };
}

// ---------------------------------------------------------------
// Phase-4 HTML renderer
// ---------------------------------------------------------------

function phase4RenderProgress(progress) {
  return `
    <div class="p4-progress">
      ${progress.map((item) => `
        <div class="p4-progress-item ${item.state}">
          <div class="p4-progress-dot">${item.index + 1}</div>
          <div class="p4-progress-label">
            ${phase4EscapeHtml(item.shortLabel)}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function phase4RenderWarningList(warnings) {
  if (!warnings.length) return '';

  return `
    <aside class="p4-warning" role="note">
      <div class="p4-warning-title">IMPORTANT</div>
      <ul>
        ${warnings.map((warning) => `
          <li>${phase4EscapeHtml(warning)}</li>
        `).join('')}
      </ul>
    </aside>
  `;
}

function phase4RenderHardware(hardware) {
  if (!hardware.length) return '';

  return `
    <section class="p4-callout p4-hardware">
      <div class="p4-callout-title">HARDWARE FOR THIS STEP</div>
      <div class="p4-chip-row">
        ${hardware.map((item) => `
          <span class="p4-chip p4-chip-hardware">
            ${phase4EscapeHtml(item)}
          </span>
        `).join('')}
      </div>
    </section>
  `;
}

function phase4RenderParts(parts) {
  if (!parts.length) return '';

  return `
    <section class="p4-callout p4-parts">
      <div class="p4-callout-title">PARTS</div>
      <div class="p4-chip-row">
        ${parts.map((item) => `
          <span class="p4-chip">
            ${phase4EscapeHtml(item)}
          </span>
        `).join('')}
      </div>
    </section>
  `;
}

function phase4RenderStep(step) {
  const ergo = Number(step.ergonomic?.score);
  const ergoText = Number.isFinite(ergo)
    ? `${phase4EscapeHtml(step.ergonomicLabel)} · ${ergo}/100 effort`
    : '';

  const prerequisites =
    phase4Array(step.prerequisiteStepIds);

  return `
    <article class="p4-step ${
      step.isClosure ? 'p4-step-closure' : ''
    } ${
      step.isIntegration ? 'p4-step-integration' : ''
    }">

      <header class="p4-step-header">
        <div class="p4-step-number">
          ${phase4EscapeHtml(step.stepId)}
        </div>

        <div class="p4-step-heading">
          <div class="p4-step-phase">
            ${phase4EscapeHtml(step.phaseLabel)}
          </div>
          <h2>${phase4EscapeHtml(step.actionLabel)}</h2>
          <div class="p4-step-subassembly">
            ${phase4EscapeHtml(
              step.subassemblyName || 'Assembly'
            )}
          </div>
        </div>

        <div class="p4-step-count">
          ${step.displayNumber} / ${step.totalSteps}
        </div>
      </header>

      <div class="p4-step-progress">
        ${phase4RenderProgress(step.progress)}
      </div>

      <div class="p4-step-main">
        <section class="p4-diagram-area">
          ${step.diagramHtml}
        </section>

        <section class="p4-instruction-area">
          <div class="p4-action-banner">
            <span class="p4-orientation-icon">
              ${phase4EscapeHtml(step.orientationIcon)}
            </span>
            <span>
              ${phase4EscapeHtml(step.orientationLabel)}
            </span>
          </div>

          <div class="p4-instruction">
            ${phase4EscapeHtml(step.instruction)}
          </div>

          ${
            step.orientationInstruction
              ? `
                <div class="p4-orientation-note">
                  ${phase4EscapeHtml(
                    step.orientationInstruction
                  )}
                </div>
              `
              : ''
          }

          ${
            prerequisites.length
              ? `
                <div class="p4-prerequisite">
                  <strong>DO AFTER:</strong>
                  ${phase4EscapeHtml(
                    prerequisites.join(', ')
                  )}
                </div>
              `
              : ''
          }

          ${phase4RenderParts(step.parts)}
          ${phase4RenderHardware(step.hardware)}
          ${phase4RenderWarningList(step.warnings)}

          ${
            step.isSubassemblyCompletion
              ? `
                <div class="p4-complete">
                  <strong>SUB-ASSEMBLY COMPLETE</strong>
                  <div>
                    ${phase4EscapeHtml(
                      step.completionInstruction ||
                      `Set ${step.subassemblyName || 'this assembly'} aside until integration.`
                    )}
                  </div>
                </div>
              `
              : ''
          }

          ${
            ergoText
              ? `
                <div class="p4-ergo">
                  ${phase4EscapeHtml(ergoText)}
                </div>
              `
              : ''
          }
        </section>
      </div>
    </article>
  `;
}
function phase4RenderCover(model) {
  const metadata = model.metadata || {};

  return `
    <section class="p4-cover">
      <div class="p4-cover-kicker">ASSEMBLY MANUAL</div>
      <h1>${phase4EscapeHtml(model.title)}</h1>
      <p class="p4-cover-subtitle">
        ${phase4EscapeHtml(model.subtitle)}
      </p>

      <div class="p4-cover-rule"></div>

      <div class="p4-cover-meta">
        <div>
          <span>PEOPLE</span>
          <strong>${phase4EscapeHtml(metadata.people || '—')}</strong>
        </div>
        <div>
          <span>TIME</span>
          <strong>${phase4EscapeHtml(metadata.estimatedTime || '—')}</strong>
        </div>
        <div>
          <span>STEPS</span>
          <strong>${model.steps.length}</strong>
        </div>
      </div>

      <div class="p4-cover-principles">
        <div class="p4-principle">
          <strong>1</strong>
          <span>Build independent components first.</span>
        </div>
        <div class="p4-principle">
          <strong>2</strong>
          <span>Install internal parts before closing access.</span>
        </div>
        <div class="p4-principle">
          <strong>3</strong>
          <span>Plug completed doors and drawers in last.</span>
        </div>
      </div>

      <div class="p4-cover-tools">
        <div class="p4-cover-section-title">TOOLS</div>
        <div class="p4-chip-row">
          ${(metadata.tools || []).map((tool) => `
            <span class="p4-chip">
              ${phase4EscapeHtml(tool)}
            </span>
          `).join('')}
        </div>
      </div>

      <div class="p4-cover-safety">
        ${phase4EscapeHtml(metadata.safety || '')}
      </div>
    </section>
  `;
}

function phase4RenderPartsPage(model) {

  const maxWidth =
    Math.max(
      ...model.parts.map(
        (part) =>
          Number(part.width) || 0
      ),
      1
    );

  const maxHeight =
    Math.max(
      ...model.parts.map(
        (part) =>
          Number(part.height) || 0
      ),
      1
    );

  const sheetWidth = 760;
  const sheetHeight = 500;

  const padding = 35;

  const columns =
    Math.min(
      5,
      Math.max(
        1,
        model.parts.length
      )
    );

  const rows =
    Math.ceil(
      model.parts.length /
      columns
    );

  const cellWidth =
    (sheetWidth - padding * 2) /
    columns;

  const cellHeight =
    (sheetHeight - padding * 2) /
    Math.max(rows, 1);

  const svgItems =
    model.parts.map(
      (part, index) => {

        const col =
          index % columns;

        const row =
          Math.floor(
            index / columns
          );

        const cellX =
          padding +
          col * cellWidth;

        const cellY =
          padding +
          row * cellHeight;

        const availableWidth =
          cellWidth - 20;

        const availableHeight =
          cellHeight - 38;

        const pw =
          Number(part.width) ||
          1;

        const ph =
          Number(part.height) ||
          1;

        const scale =
          Math.min(
            availableWidth / pw,
            availableHeight / ph
          );

        const shapeWidth =
          Math.max(
            8,
            pw * scale
          );

        const shapeHeight =
          Math.max(
            8,
            ph * scale
          );

        const x =
          cellX +
          (
            cellWidth -
            shapeWidth
          ) / 2;

        const y =
          cellY + 4;

        const role =
          phase4EscapeHtml(
            part.roleLabel
          );

        const code =
          phase4EscapeHtml(
            part.code
          );

        const name =
          phase4EscapeHtml(
            part.name
          );

        const subassembly =
          phase4EscapeHtml(
            part.subassembly ||
            'Main carcass'
          );

        const dimensions =
          [
            part.width,
            part.height,
            part.thickness,
          ]
            .map(
              (value) =>
                Number(value) > 0
                  ? Math.round(
                      Number(value) * 1000
                    )
                  : '—'
            )
            .join(' × ');

        return `
          <g>

            <rect
              x="${cellX.toFixed(2)}"
              y="${cellY.toFixed(2)}"
              width="${cellWidth.toFixed(2)}"
              height="${cellHeight.toFixed(2)}"
              fill="#fff"
              stroke="#d0d0cc"
              stroke-width="1"
            />

            <rect
              x="${x.toFixed(2)}"
              y="${y.toFixed(2)}"
              width="${shapeWidth.toFixed(2)}"
              height="${shapeHeight.toFixed(2)}"
              fill="#eeeeea"
              stroke="#222"
              stroke-width="1.5"
            />

            <text
              x="${cellX + 5}"
              y="${cellY + cellHeight - 23}"
              font-size="10"
              font-weight="900"
              fill="#111"
            >
              ${code}
            </text>

            <text
              x="${cellX + 5}"
              y="${cellY + cellHeight - 12}"
              font-size="7.5"
              font-weight="700"
              fill="#222"
            >
              ${role} · ${name}
            </text>

            <text
              x="${cellX + 5}"
              y="${cellY + cellHeight - 3}"
              font-size="6.5"
              fill="#666"
            >
              ${dimensions} mm · ${subassembly}
            </text>

          </g>
        `;
      }
    ).join('');

  return `
    <section class="p4-reference-page p4-parts-sheet">

      <div class="p4-reference-kicker">
        REFERENCE
      </div>

      <h1>
        Parts & sub-assemblies
      </h1>

      <p class="p4-reference-intro">
        Every panel is shown once, at proportional size.
        Use the code and dimensions to identify each part
        before assembly.
      </p>

      <svg
        class="p4-parts-sheet-svg"
        viewBox="0 0 ${sheetWidth} ${sheetHeight}"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="xMidYMid meet"
      >
        ${svgItems}
      </svg>

    </section>
  `;
}

function phase4RenderHardwarePage(model) {
  return `
    <section class="p4-reference-page">
      <div class="p4-reference-kicker">REFERENCE</div>
      <h1>Hardware</h1>
      <p class="p4-reference-intro">
        Hardware is also repeated at the point of use in each assembly step.
      </p>

      ${
        model.hardware.length
          ? `
            <div class="p4-hardware-table">
              ${model.hardware.map((item) => `
                <div class="p4-hardware-row">
                  <strong>${phase4EscapeHtml(item.id)}</strong>
                  <span>${item.count} use${item.count === 1 ? '' : 's'}</span>
                  <span>${phase4EscapeHtml(item.uses.join(', '))}</span>
                </div>
              `).join('')}
            </div>
          `
          : `
            <div class="p4-empty">
              No hardware was reported by the assembly model.
            </div>
          `
      }
    </section>
  `;
}

function phase4RenderChecklist(model) {
  return `
    <section class="p4-checklist-page">
      <div class="p4-reference-kicker">FINISH</div>
      <h1>Final check & adjustment</h1>

      <div class="p4-final-message">
        The structure is complete. Finish by checking movement, alignment,
        stability, and unused hardware.
      </div>

      <div class="p4-checklist">
        ${model.finalChecklist.map((item, index) => `
          <div class="p4-check-row">
            <div class="p4-check-box"></div>
            <div>
              <span class="p4-check-number">${index + 1}</span>
              ${phase4EscapeHtml(item)}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="p4-adjustment-box">
        <strong>DOOR / DRAWER ADJUSTMENT</strong>
        <p>
          Make final adjustments only after the furniture is fully assembled
          and standing in its normal position.
        </p>
      </div>
    </section>
  `;
}

/**
 * Render a complete printable HTML manual.
 *
 * The returned string has no external dependencies. It can be inserted into
 * an iframe, opened in a browser, or passed to an existing HTML→PDF engine.
 */
export function renderAssemblyManualHtml(
  model
) {
  const stepsHtml = model.steps
    .map(phase4RenderStep)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${phase4EscapeHtml(model.title)}</title>
<style>
  @page {
    size: A4;
    margin: 0;
  }

  :root {
    --p4-ink: #151515;
    --p4-muted: #666;
    --p4-light: #f3f3f1;
    --p4-line: #d8d8d4;
    --p4-panel: #ffffff;
    --p4-warning: #fff1cf;
    --p4-warning-line: #d79b20;
    --p4-accent: #111111;
    --p4-success: #e8f2e9;
  }

  * {
    box-sizing: border-box;
  }

  html,
  body {
    margin: 0;
    padding: 0;
    color: var(--p4-ink);
    background: #e7e7e4;
    font-family: Arial, Helvetica, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  body {
    font-size: 12pt;
    line-height: 1.35;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  .p4-parts-sheet {
    height: 277mm;
    overflow: hidden;
  }

  .p4-parts-sheet-svg {
    display: block;
    width: 100%;
    height: 220mm;
    max-height: 220mm;
  }

  .p4-assembly-state {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 158mm;
  }

  .p4-diagram-area {
    overflow: hidden;
  }
  .p4-cover,
  .p4-reference-page,
  .p4-checklist-page,
  .p4-step {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 10mm;
    background: var(--p4-panel);
    padding: 17mm;
    page-break-after: always;
    break-after: page;
    position: relative;
    overflow: hidden;
  }

  .p4-cover {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .p4-cover-kicker,
  .p4-reference-kicker {
    font-size: 9pt;
    font-weight: 800;
    letter-spacing: .18em;
    color: var(--p4-muted);
    margin-bottom: 7mm;
  }

  .p4-cover h1 {
    font-size: 34pt;
    line-height: 1.05;
    max-width: 160mm;
    margin-bottom: 6mm;
  }

  .p4-cover-subtitle {
    font-size: 16pt;
    color: var(--p4-muted);
    max-width: 145mm;
  }

  .p4-cover-rule {
    width: 35mm;
    border-top: 3px solid var(--p4-ink);
    margin: 12mm 0;
  }

  .p4-cover-meta {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4mm;
    margin-bottom: 14mm;
  }

  .p4-cover-meta div {
    border: 1px solid var(--p4-line);
    padding: 5mm;
  }

  .p4-cover-meta span {
    display: block;
    font-size: 8pt;
    font-weight: 800;
    color: var(--p4-muted);
    letter-spacing: .12em;
    margin-bottom: 2mm;
  }

  .p4-cover-meta strong {
    font-size: 16pt;
  }

  .p4-cover-principles {
    display: grid;
    gap: 4mm;
    margin-bottom: 12mm;
  }

  .p4-principle {
    display: grid;
    grid-template-columns: 10mm 1fr;
    gap: 4mm;
    align-items: center;
    padding: 4mm;
    background: var(--p4-light);
  }

  .p4-principle strong {
    width: 8mm;
    height: 8mm;
    border: 2px solid var(--p4-ink);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .p4-cover-section-title,
  .p4-callout-title {
    font-size: 8pt;
    font-weight: 800;
    letter-spacing: .13em;
    color: var(--p4-muted);
    margin-bottom: 2mm;
  }

  .p4-cover-tools {
    margin-bottom: 10mm;
  }

  .p4-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 2mm;
  }

  .p4-chip {
    display: inline-flex;
    align-items: center;
    min-height: 8mm;
    padding: 1.5mm 3mm;
    border: 1px solid var(--p4-line);
    background: #fff;
    font-weight: 700;
    font-size: 9pt;
  }

  .p4-chip-hardware {
    border-width: 2px;
  }

  .p4-cover-safety {
    color: var(--p4-muted);
    font-size: 9pt;
    border-top: 1px solid var(--p4-line);
    padding-top: 4mm;
  }

  .p4-reference-page h1,
  .p4-checklist-page h1 {
    font-size: 27pt;
    margin-bottom: 5mm;
  }

  .p4-reference-intro {
    color: var(--p4-muted);
    max-width: 155mm;
    margin-bottom: 9mm;
  }

  .p4-reference-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 3mm;
  }

  .p4-part-card {
    border: 1px solid var(--p4-line);
    min-height: 24mm;
    padding: 4mm;
  }

  .p4-part-code {
    font-size: 14pt;
    font-weight: 900;
    margin-bottom: 1mm;
  }

  .p4-part-name {
    font-weight: 700;
  }

  .p4-part-meta {
    color: var(--p4-muted);
    font-size: 8pt;
    margin-top: 2mm;
  }

  .p4-reference-heading {
    margin-top: 11mm;
    font-size: 16pt;
  }

  .p4-subassembly-list {
    display: grid;
    gap: 3mm;
  }

  .p4-subassembly-row {
    display: grid;
    grid-template-columns: 55mm 1fr;
    gap: 5mm;
    padding: 4mm;
    border: 1px solid var(--p4-line);
  }

  .p4-subassembly-row strong,
  .p4-subassembly-row span {
    display: block;
  }

  .p4-subassembly-row span {
    color: var(--p4-muted);
    font-size: 8pt;
    margin-top: 1mm;
  }

  .p4-hardware-table {
    border-top: 2px solid var(--p4-ink);
  }

  .p4-hardware-row {
    display: grid;
    grid-template-columns: 55mm 25mm 1fr;
    gap: 4mm;
    padding: 4mm 2mm;
    border-bottom: 1px solid var(--p4-line);
  }

  .p4-empty {
    padding: 10mm;
    background: var(--p4-light);
    color: var(--p4-muted);
  }

  .p4-step {
    padding: 11mm 13mm;
  }

  .p4-step-header {
    display: grid;
    grid-template-columns: 19mm 1fr auto;
    gap: 4mm;
    align-items: center;
    border-bottom: 1px solid var(--p4-line);
    padding-bottom: 5mm;
  }

  .p4-step-number {
    width: 15mm;
    height: 15mm;
    border: 2px solid var(--p4-ink);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 900;
    font-size: 10pt;
  }

  .p4-step-phase {
    font-size: 8pt;
    font-weight: 800;
    color: var(--p4-muted);
    letter-spacing: .12em;
    margin-bottom: 1mm;
  }

  .p4-step-heading h2 {
    margin: 0;
    font-size: 21pt;
    line-height: 1.05;
  }

  .p4-step-subassembly {
    color: var(--p4-muted);
    font-size: 9pt;
    margin-top: 1.5mm;
  }

  .p4-step-count {
    color: var(--p4-muted);
    font-size: 9pt;
    font-weight: 700;
  }

  .p4-step-progress {
    margin: 4mm 0 6mm;
  }

  .p4-progress {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 2mm;
  }

  .p4-progress-item {
    min-height: 11mm;
    display: grid;
    grid-template-columns: 7mm 1fr;
    align-items: center;
    gap: 2mm;
    color: #aaa;
  }

  .p4-progress-item.current {
    color: var(--p4-ink);
    font-weight: 900;
  }

  .p4-progress-item.complete {
    color: var(--p4-ink);
  }

  .p4-progress-dot {
    width: 6mm;
    height: 6mm;
    border-radius: 50%;
    border: 1px solid currentColor;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 7pt;
    font-weight: 800;
  }

  .p4-progress-item.current .p4-progress-dot {
    border-width: 2px;
  }

  .p4-progress-label {
    font-size: 6.5pt;
    letter-spacing: .05em;
  }

  .p4-step-main {
    display: grid;
    grid-template-columns: 55% 45%;
    min-height: 208mm;
  }

  .p4-diagram-area {
    min-height: 165mm;
    overflow: hidden;
    border: 1px solid var(--p4-line);
    background: #fafaf8;
    padding: 7mm;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .p4-diagram-fallback {
    width: 100%;
    height: 150mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 5mm;
    position: relative;
  }

  .p4-diagram-panel,
  .p4-diagram-target {
    width: 60mm;
    min-height: 34mm;
    border: 2px solid var(--p4-ink);
    display: flex;
    justify-content: center;
    align-items: center;
    font-weight: 900;
    text-align: center;
    padding: 3mm;
  }

  .p4-diagram-target {
    width: 78mm;
    min-height: 42mm;
    background: #ecece8;
  }

  .p4-diagram-arrow {
    font-size: 20pt;
    line-height: 1;
  }

  .p4-diagram-action {
    position: absolute;
    bottom: 3mm;
    font-size: 8pt;
    font-weight: 800;
    letter-spacing: .13em;
    color: var(--p4-muted);
  }

  .p4-instruction-area {
    padding: 0 0 0 7mm;
  }

  .p4-action-banner {
    min-height: 13mm;
    background: var(--p4-ink);
    color: #fff;
    display: flex;
    align-items: center;
    gap: 3mm;
    padding: 3mm 4mm;
    font-size: 8pt;
    font-weight: 900;
    letter-spacing: .08em;
  }

  .p4-orientation-icon {
    font-size: 16pt;
    line-height: 1;
  }

  .p4-instruction {
    font-size: 15pt;
    line-height: 1.3;
    font-weight: 700;
    padding: 6mm 0;
  }

  .p4-orientation-note {
    border-left: 3px solid var(--p4-ink);
    padding: 2mm 0 2mm 3mm;
    font-size: 9pt;
    color: var(--p4-muted);
    margin-bottom: 5mm;
  }

  .p4-prerequisite {
    background: var(--p4-light);
    padding: 3mm;
    font-size: 8pt;
    margin-bottom: 4mm;
  }

  .p4-callout {
    margin-top: 4mm;
  }

  .p4-warning {
    margin-top: 5mm;
    padding: 4mm;
    background: var(--p4-warning);
    border-left: 4px solid var(--p4-warning-line);
  }

  .p4-warning-title {
    font-size: 8pt;
    font-weight: 900;
    letter-spacing: .12em;
    margin-bottom: 2mm;
  }

  .p4-warning ul {
    margin: 0;
    padding-left: 5mm;
    font-size: 9pt;
  }

  .p4-warning li + li {
    margin-top: 1.5mm;
  }

  .p4-complete {
    margin-top: 5mm;
    padding: 4mm;
    background: var(--p4-success);
    border: 1px solid #b7ceb9;
    font-size: 9pt;
  }

  .p4-complete strong {
    display: block;
    font-size: 8pt;
    letter-spacing: .1em;
    margin-bottom: 1mm;
  }

  .p4-ergo {
    margin-top: 6mm;
    color: var(--p4-muted);
    font-size: 7pt;
  }

  .p4-step-closure .p4-action-banner,
  .p4-step-integration .p4-action-banner {
    letter-spacing: .11em;
  }

  .p4-final-message {
    max-width: 145mm;
    padding: 5mm;
    background: var(--p4-light);
    margin-bottom: 10mm;
  }

  .p4-checklist {
    display: grid;
    gap: 4mm;
  }

  .p4-check-row {
    display: grid;
    grid-template-columns: 10mm 1fr;
    gap: 4mm;
    align-items: center;
    padding: 5mm;
    border: 1px solid var(--p4-line);
    font-size: 12pt;
  }

  .p4-check-box {
    width: 7mm;
    height: 7mm;
    border: 2px solid var(--p4-ink);
  }

  .p4-check-number {
    color: var(--p4-muted);
    font-size: 8pt;
    font-weight: 900;
    margin-right: 2mm;
  }

  .p4-adjustment-box {
    margin-top: 12mm;
    border: 2px solid var(--p4-ink);
    padding: 6mm;
  }

  .p4-adjustment-box strong {
    display: block;
    margin-bottom: 2mm;
  }

  .p4-adjustment-box p {
    margin: 0;
    color: var(--p4-muted);
  }

  @media print {
    html,
    body {
      background: #fff;
    }

    .p4-cover,
    .p4-reference-page,
    .p4-checklist-page,
    .p4-step {
      margin: 0;
    }
  }
</style>
</head>
<body>

${phase4RenderCover(model)}
${phase4RenderPartsPage(model)}
${phase4RenderHardwarePage(model)}
${stepsHtml}
${phase4RenderChecklist(model)}

</body>
</html>`;
}

/**
 * Convenience function for hosts that already have the Phase-3 sequence.
 */
export function buildAssemblyManualHtml(
  sequence,
  options = {}
) {
  const model =
    buildAssemblyManualModel(
      sequence,
      options
    );

  return renderAssemblyManualHtml(
    model
  );
}


/**
 * Phase 4 printable/exportable assembly manual.
 *
 * Builds the Phase 4 HTML manual and opens it in a
 * print window so the browser can print/save it as PDF.
 */
export function exportAssemblyManualPdf(
  sequence,
  {
    projectName = 'Assembly Instructions',
    mode = 'open',
    panels = [],
    resolvedPanels = [],
  } = {}
) {
  const html = buildAssemblyManualHtml(
    sequence,
    {
      title: projectName,
      subtitle: 'Human-first assembly instructions',

      panels,

      resolvedPanels,
    }
  );

  if (mode === 'open') {
    const printWindow = window.open('', '_blank');

    if (!printWindow) {
      throw new Error(
        'Unable to open the assembly manual. Please allow pop-ups for this application.'
      );
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();

    printWindow.addEventListener('load', () => {
      printWindow.focus();
      printWindow.print();
    });

    return;
  }

  const printWindow = window.open('', '_blank');

  if (!printWindow) {
    throw new Error(
      'Unable to open the assembly manual. Please allow pop-ups for this application.'
    );
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
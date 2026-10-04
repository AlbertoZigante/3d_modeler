/**
 * engine/assembly.js — ASSEMBLY SEQUENCING (Phase 3).
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
 * PHASE 2
 * --------
 * Adds heuristic ergonomics scoring for:
 *   - reach
 *   - tool access
 *   - support / holding
 *   - weight / size
 *   - posture
 *   - two-person handling
 *   - repositioning
 *
 * Hard assembly constraints always take precedence over ergonomic score.
 *
 * PHASE 3 HUMAN-READABLE ASSEMBLY MODEL
 * ---------------------------------------
 * Every step is now a user-facing assembly action, with:
 *   - stable stepId
 *   - subassembly identity/name
 *   - action verb
 *   - instruction
 *   - prerequisites
 *   - warnings
 *   - orientation instruction
 *   - completion state
 *
 * Preparation, assembly, closure, and final integration are represented
 * explicitly so the PDF layer can render the same model without
 * reconstructing assembly logic.
 *
 * THE CORE INSIGHT: TWO KINDS OF EDGES
 * --------------------------------------
 * A Joint (corner_butt/t_butt/face_to_face — "structural" edges) means
 * two panels are RIGIDLY joined and belong in the same sub-assembly,
 * built up panel by panel.
 *
 * A FeatureJoint (drawer_slide/door_hinge — "integration" edges) means
 * two ALREADY-COMPLETE sub-assemblies get connected to each other.
 *
 * So:
 *
 *   1. Cluster panels into rigid sub-assemblies using ONLY structural
 *      joints.
 *   2. Order each cluster's own panels internally.
 *   3. Schedule integration only after the participating sub-assemblies
 *      are complete.
 *
 * PRE-INSTALL
 * -----------
 * Hardware that fastens onto a SINGLE panel should be installed while
 * that panel is still separate and fully accessible:
 *
 *   - hinge cup on door
 *   - hinge mounting plate on carcass
 *   - runner bracket on drawer
 *   - runner bracket on carcass side
 *
 * KNOWN GAP
 * ---------
 * Drawer-front attachment is not currently modeled as a structural or
 * FeatureJoint. If a drawer front has no modeled connection, it is flagged
 * as unattached rather than silently dropped.
 */

import { resolveConstraints } from '../modeller/snap.js';
import { detectJoints, detectFeatureJoints } from './joints.js';
import { buildHardwarePlan } from './hardware.js';

const STRUCTURAL_JOINT_TYPES = new Set([
  'corner_butt',
  't_butt',
  'face_to_face',
]);

// ---------------------------------------------------------------
// Connected components over the STRUCTURAL graph only
// ---------------------------------------------------------------

function computeClusters(panelIds, structuralJoints) {
  const adjacency = new Map(
    panelIds.map((id) => [id, new Set()])
  );

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
 * @property {number} index
 * @property {'pre_install'|'join'|'integrate'|'unattached'} kind
 * @property {'prepare'|'subassembly'|'internal'|'closure'|'integration'|'unattached'} phase
 * @property {'flat'|'upright'|'rear_access'|'front_access'|'unknown'} orientation
 * @property {boolean} requiresReposition
 * @property {number} repositionCost
 * @property {string[]} panelIds
 * @property {string[]} otherPanelIds
 * @property {string[]} panelNames
 * @property {string[]} panelCodes
 * @property {string[]} jointIds
 * @property {object[]} hardware
 * @property {string} description
 * @property {string} stepId
 * @property {string} subassemblyId
 * @property {string} subassemblyName
 * @property {string} action
 * @property {string} instruction
 * @property {string[]} warnings
 * @property {string[]} prerequisiteStepIds
 * @property {boolean} subassemblyComplete
 */

// ---------------------------------------------------------------
// Phase-1 semantic ordering helpers
// ---------------------------------------------------------------

function textOfPanel(panel) {
  return [
    panel?.name,
    panel?.pieceCode,
    panel?.code,
    panel?.type,
    panel?.role,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function panelRole(panel) {
  if (!panel) return 'unknown';

  if (panel.isDoor) return 'door';
  if (panel.isDrawerFront) return 'drawer_front';
  if (panel.isDrawerBoxPanel) return 'drawer_box';

  if (panel.isBack || panel.role === 'back') return 'back';
  if (panel.isTop || panel.role === 'top') return 'top';
  if (panel.isBottom || panel.role === 'bottom') return 'bottom';

  if (
    panel.isVerticalDivider ||
    panel.role === 'vertical_divider'
  ) {
    return 'vertical';
  }

  if (
    panel.isShelf ||
    panel.role === 'horizontal_shelf'
  ) {
    return 'horizontal';
  }

  const t = textOfPanel(panel);

  if (
    /drawer[ _-]*(front|face)|front[ _-]*drawer/.test(t)
  ) {
    return 'drawer_front';
  }

  if (
    /drawer[ _-]*(box|side)|drawer/.test(t) &&
    /box|side/.test(t)
  ) {
    return 'drawer_box';
  }

  if (/door/.test(t)) return 'door';
  if (/back|rear/.test(t)) return 'back';
  if (/top|upper|roof/.test(t)) return 'top';
  if (/bottom|base|plinth/.test(t)) return 'bottom';

  if (
    /vertical|divider|partition|upright|centre.?panel|center.?panel/.test(t)
  ) {
    return 'vertical';
  }

  if (
    /shelf|shelves|horizontal|fixed.?shelf|adjustable.?shelf/.test(t)
  ) {
    return 'horizontal';
  }

  return 'unknown';
}

function clusterRole(cluster, rawById) {
  const roles = [...cluster].map((id) =>
    panelRole(rawById.get(id))
  );

  if (roles.every((r) => r === 'door')) {
    return 'door';
  }

  if (roles.every((r) => r === 'drawer_box')) {
    return 'drawer_box';
  }

  if (roles.every((r) => r === 'drawer_front')) {
    return 'drawer_front';
  }

  if (roles.includes('door')) return 'door';
  if (roles.includes('drawer_box')) return 'drawer_box';

  return 'carcass';
}

function desiredOrientation(role) {
  if (
    role === 'door' ||
    role === 'drawer_box' ||
    role === 'drawer_front'
  ) {
    return 'flat';
  }

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
  return ({
    door: 10,
    drawer_box: 20,
    drawer_front: 25,
    carcass: 40,
  })[role] ?? 40;
}

function roleOfStepPanel(panelId, rawById) {
  return panelRole(rawById.get(panelId));
}

// ---------------------------------------------------------------
// Phase-2 ergonomic scoring
// ---------------------------------------------------------------

function clamp10(value) {
  return Math.max(0, Math.min(10, value));
}

function numericDimension(panel, keys) {
  for (const key of keys) {
    const value = Number(panel?.[key]);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return 0;
}

function panelErgonomicSize(panel, resolved) {
  const width =
    numericDimension(panel, [
      'width',
      'w',
      'lengthX',
    ]) ||
    Number(resolved?.width) ||
    0;

  const height =
    numericDimension(panel, [
      'height',
      'h',
      'lengthY',
    ]) ||
    Number(resolved?.height) ||
    0;

  const thickness =
    numericDimension(panel, [
      'thickness',
      'depth',
      'd',
    ]) ||
    Number(resolved?.thickness) ||
    0;

  const area = width * height;
  const maxSpan = Math.max(width, height);

  return {
    width,
    height,
    thickness,
    area,
    maxSpan,
  };
}

function ergonomicPanelMetrics(panel, resolved) {
  const role = panelRole(panel);

  const size = panelErgonomicSize(
    panel,
    resolved
  );

  const area = size.area;

  const largePanel =
    area > 1.5 ||
    size.maxSpan > 2.0;

  const veryLargePanel =
    area > 2.5 ||
    size.maxSpan > 2.5;

  const explicitWeight = numericDimension(
    panel,
    [
      'weight',
      'mass',
      'kg',
      'weightKg',
    ]
  );

  /*
   * Weight is preferably supplied by the model.
   * Otherwise use a conservative size proxy.
   *
   * This is intentionally NOT a physical mass calculation.
   */
  const weightScore = explicitWeight
    ? clamp10(explicitWeight / 8)
    : clamp10(
        area * 2.0 +
        (size.thickness > 0.025 ? 0.5 : 0)
      );

  const supportScore =
    role === 'door' ||
    role === 'drawer_box' ||
    role === 'drawer_front'
      ? clamp10(1 + area * 1.5)
      : clamp10(0.5 + area * 1.7);

  return {
    role,
    ...size,
    largePanel,
    veryLargePanel,
    weightScore,
    supportScore,
  };
}

function jointToolAccessScore(joints) {
  if (!joints?.length) return 0;

  let score = 0;

  joints.forEach((j) => {
    const type = String(
      j?.type ||
      j?.kind ||
      ''
    ).toLowerCase();

    if (
      /corner|butt|t_butt/.test(type)
    ) {
      score += 1;
    } else if (
      /face_to_face|edge/.test(type)
    ) {
      score += 1.5;
    } else {
      score += 1.25;
    }

    if (
      /blind|hidden|rear|inside|interior/.test(type)
    ) {
      score += 2;
    }
  });

  return clamp10(
    score / Math.max(1, joints.length) * 2
  );
}

function ergonomicStepScore({
  panel,
  resolved,
  role,
  joints = [],
  orientation,
  fromOrientation,
  kind,
}) {
  const metrics = ergonomicPanelMetrics(
    panel,
    resolved
  );

  const reach =
    metrics.veryLargePanel
      ? 5
      : metrics.largePanel
        ? 3
        : 1;

  const toolAccess =
    jointToolAccessScore(joints);

  const support =
    metrics.supportScore;

  const weight =
    metrics.weightScore;

  const posture =
    orientation === 'rear_access'
      ? 1.5
      : orientation === 'upright'
        ? (
            metrics.largePanel
              ? 3.5
              : 2
          )
        : 1;

  const twoPerson =
    panel?.requiresTwoPeople ||
    panel?.twoPerson ||
    panel?.assemblyTwoPerson
      ? 10
      : metrics.veryLargePanel
        ? 8
        : metrics.largePanel
          ? 4
          : 0;

  const reposition =
    fromOrientation &&
    orientation &&
    fromOrientation !== orientation &&
    fromOrientation !== 'unknown' &&
    orientation !== 'unknown'
      ? 2
      : 0;

  const integrationPenalty =
    kind === 'integrate'
      ? 0.5
      : 0;

  /*
   * Weighted human-effort score.
   * Lower = easier.
   */
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

function ergonomicClusterScore(
  clusterIds,
  rawById,
  resolvedById
) {
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

  return count
    ? total / count
    : 0;
}

function orderClusterPanelsPhase1(
  clusterIds,
  structuralJoints,
  resolvedById,
  codeOf,
  rawById
) {
  const jointsByPanel = new Map(
    [...clusterIds].map((id) => [id, []])
  );

  structuralJoints.forEach((j) => {
    if (
      clusterIds.has(j.panelA) &&
      clusterIds.has(j.panelB)
    ) {
      jointsByPanel
        .get(j.panelA)
        .push(j);

      jointsByPanel
        .get(j.panelB)
        .push(j);
    }
  });

  const areaOf = (id) => {
    const r = resolvedById.get(id);

    return r
      ? r.width * r.height
      : 0;
  };

  const remaining = new Set(clusterIds);
  const placed = [];
  const steps = [];

  /*
   * Start with the highest-priority panel.
   */
  const anchor = [...remaining].sort(
    (a, b) => {
      const pa = panelPriority(
        panelRole(rawById.get(a))
      );

      const pb = panelPriority(
        panelRole(rawById.get(b))
      );

      if (pa !== pb) {
        return pa - pb;
      }

      const aa = areaOf(a);
      const ab = areaOf(b);

      if (aa !== ab) {
        return ab - aa;
      }

      return codeOf(a)
        .localeCompare(codeOf(b));
    }
  )[0];

  remaining.delete(anchor);
  placed.push(anchor);

  steps.push({
    newPanel: anchor,
    joints: [],
  });

  while (remaining.size) {
    const candidates = [];

    remaining.forEach((candidateId) => {
      const connecting =
        jointsByPanel
          .get(candidateId)
          .filter(
            (j) =>
              placed.includes(j.panelA) ||
              placed.includes(j.panelB)
          );

      if (connecting.length) {
        candidates.push({
          candidateId,
          connecting,
        });
      }
    });

    if (!candidates.length) {
      throw new Error(
        'orderClusterPanelsPhase1: cluster is not fully connected'
      );
    }

    candidates.sort((a, b) => {
      const pa = panelPriority(
        panelRole(
          rawById.get(a.candidateId)
        )
      );

      const pb = panelPriority(
        panelRole(
          rawById.get(b.candidateId)
        )
      );

      /*
       * Hard role ordering wins.
       */
      if (pa !== pb) {
        return pa - pb;
      }

      /*
       * Within the same role, prefer the
       * easier operation.
       */
      const aRole = panelRole(
        rawById.get(a.candidateId)
      );

      const bRole = panelRole(
        rawById.get(b.candidateId)
      );

      const previousRole =
        panelRole(
          rawById.get(
            placed[placed.length - 1]
          )
        );

      const previousOrientation =
        desiredOrientation(
          previousRole
        );

      const aErgo =
        ergonomicStepScore({
          panel:
            rawById.get(
              a.candidateId
            ),
          resolved:
            resolvedById.get(
              a.candidateId
            ),
          role: aRole,
          joints: a.connecting,
          orientation:
            desiredOrientation(aRole),
          fromOrientation:
            previousOrientation,
          kind: 'join',
        }).score;

      const bErgo =
        ergonomicStepScore({
          panel:
            rawById.get(
              b.candidateId
            ),
          resolved:
            resolvedById.get(
              b.candidateId
            ),
          role: bRole,
          joints: b.connecting,
          orientation:
            desiredOrientation(bRole),
          fromOrientation:
            previousOrientation,
          kind: 'join',
        }).score;

      if (aErgo !== bErgo) {
        return aErgo - bErgo;
      }

      if (
        b.connecting.length !==
        a.connecting.length
      ) {
        return (
          b.connecting.length -
          a.connecting.length
        );
      }

      const aa =
        areaOf(a.candidateId);

      const ab =
        areaOf(b.candidateId);

      if (aa !== ab) {
        return ab - aa;
      }

      return codeOf(
        a.candidateId
      ).localeCompare(
        codeOf(b.candidateId)
      );
    });

    const best = candidates[0];

    remaining.delete(
      best.candidateId
    );

    placed.push(
      best.candidateId
    );

    steps.push({
      newPanel:
        best.candidateId,
      joints:
        best.connecting,
    });
  }

  return steps;
}

// ---------------------------------------------------------------
// Phase-3 human-readable assembly model
// ---------------------------------------------------------------

function subassemblyLabel(
  role,
  ordinal
) {
  if (role === 'door') {
    return `Door assembly ${ordinal}`;
  }

  if (role === 'drawer_box') {
    return `Drawer assembly ${ordinal}`;
  }

  if (role === 'drawer_front') {
    return `Drawer front assembly ${ordinal}`;
  }

  if (role === 'carcass') {
    return ordinal === 1
      ? 'Main carcass'
      : `Carcass assembly ${ordinal}`;
  }

  return `Sub-assembly ${ordinal}`;
}

function actionForStep(
  kind,
  phase,
  role
) {
  if (kind === 'pre_install') {
    return 'prepare';
  }

  if (kind === 'integrate') {
    return 'integrate';
  }

  if (kind === 'unattached') {
    return 'inspect';
  }

  if (phase === 'closure') {
    return 'close';
  }

  if (
    role === 'door' ||
    role === 'drawer_box' ||
    role === 'drawer_front'
  ) {
    return 'assemble';
  }

  return 'install';
}

function roleDisplay(role) {
  return ({
    door: 'door',
    drawer_box: 'drawer box',
    drawer_front: 'drawer front',
    back: 'back panel',
    top: 'top panel',
    bottom: 'bottom panel',
    vertical: 'vertical divider',
    horizontal: 'horizontal shelf',
  })[role] || 'component';
}

function humanInstruction({
  kind,
  phase,
  role,
  panelCode,
  otherCodes,
  hardware,
  description,
}) {
  if (kind === 'pre_install') {
    const hw = hardware?.[0];

    const hwName =
      hw?.displayId ||
      hw?.hardware?.series ||
      hw?.hardware?.kind ||
      'hardware';

    return (
      `Prepare ${panelCode}: ` +
      `install ${hwName} while the panel ` +
      `is separate and fully accessible.`
    );
  }

  if (kind === 'integrate') {
    return description;
  }

  if (kind === 'unattached') {
    return (
      `Identify ${panelCode} and set it aside; ` +
      `no assembly connection is currently modeled ` +
      `for this part.`
    );
  }

  if (
    phase === 'closure' &&
    role === 'back'
  ) {
    return (
      `Install ${panelCode} as the back panel ` +
      `after all accessible internal components ` +
      `are installed.`
    );
  }

  if (
    phase === 'closure' &&
    role === 'top'
  ) {
    return (
      `Install ${panelCode} as the top panel ` +
      `only after the internal assembly and ` +
      `back panel are complete.`
    );
  }

  if (role === 'vertical') {
    return (
      `Install ${panelCode} as the vertical ` +
      `divider before installing the top panel.`
    );
  }

  if (role === 'horizontal') {
    return (
      `Install ${panelCode} as a horizontal shelf ` +
      `before closing the rear with the back panel.`
    );
  }

  if (
    kind === 'join' &&
    otherCodes?.length
  ) {
    return (
      `Attach ${panelCode} to ` +
      `${otherCodes.join(', ')}.`
    );
  }

  return description;
}

function warningsForStep({
  kind,
  phase,
  role,
}) {
  const warnings = [];

  if (role === 'door') {
    warnings.push(
      'Build the door flat before hanging it on the carcass.'
    );

    if (kind === 'integrate') {
      warnings.push(
        'Support the door while connecting the pre-fitted hinges.'
      );
    }
  }

  if (role === 'drawer_box') {
    warnings.push(
      'Complete the drawer box before inserting it into the carcass.'
    );
  }

  if (role === 'vertical') {
    warnings.push(
      'Install vertical dividers before the top panel closes access.'
    );
  }

  if (role === 'horizontal') {
    warnings.push(
      'Install horizontal shelves before the back panel closes rear access.'
    );
  }

  if (role === 'back') {
    warnings.push(
      'Do not install the back until all required internal components are in place.'
    );
  }

  if (role === 'top') {
    warnings.push(
      'Do not install the top until the internal components and back panel are complete.'
    );
  }

  if (kind === 'pre_install') {
    warnings.push(
      'Keep the panel separate while fitting this hardware.'
    );
  }

  return [...new Set(warnings)];
}

function orientationInstruction(
  orientation
) {
  return ({
    flat:
      'Work with the component flat on a supported surface.',

    rear_access:
      'Keep the rear/open face accessible for this operation.',

    front_access:
      'Keep the front face accessible for this operation.',

    upright:
      'Work with the furniture upright and stable.',

    unknown:
      'Use the orientation that keeps the joint and tool access clear.',
  })[orientation] || '';
}

function finalizeHumanReadableModel(
  steps
) {
  /*
   * Completion means the independent build is
   * finished, not that the later integration step
   * has happened.
   */
  const lastBuildStepBySubassembly =
    new Map();

  steps.forEach((step) => {
    if (
      step.subassemblyId &&
      step.action !== 'integrate'
    ) {
      lastBuildStepBySubassembly.set(
        step.subassemblyId,
        step
      );
    }
  });

  steps.forEach((step) => {
    step.stepId =
      `S${String(step.index).padStart(2, '0')}`;

    step.prerequisiteStepIds = [];

    const warnings = [
      ...(step.warnings || []),
    ];

    /*
     * Integration depends on completion of
     * every participating subassembly.
     */
    if (
      step.action === 'integrate' &&
      step.subassemblyId
    ) {
      const ids =
        step.integrationSubassemblyIds ||
        [];

      ids.forEach((id) => {
        const last =
          lastBuildStepBySubassembly.get(id);

        if (
          last &&
          last.stepId !== step.stepId
        ) {
          step.prerequisiteStepIds.push(
            last.stepId
          );
        }
      });
    }

    /*
     * Back depends on prior internal work.
     */
    if (step.role === 'back') {
      const priorInternal =
        steps.filter(
          (s) =>
            s.index < step.index &&
            s.phase === 'internal'
        );

      if (priorInternal.length) {
        step.prerequisiteStepIds.push(
          priorInternal[
            priorInternal.length - 1
          ].stepId
        );
      }
    }

    /*
     * Top depends on back/internal completion.
     */
    if (step.role === 'top') {
      const priorClosure =
        steps.filter(
          (s) =>
            s.index < step.index &&
            (
              s.role === 'back' ||
              s.phase === 'internal'
            )
        );

      if (priorClosure.length) {
        step.prerequisiteStepIds.push(
          priorClosure[
            priorClosure.length - 1
          ].stepId
        );
      }
    }

    step.prerequisiteStepIds =
      [...new Set(
        step.prerequisiteStepIds
      )];

    step.orientationInstruction =
      orientationInstruction(
        step.orientation
      );

    step.warnings =
      [...new Set(warnings)];
  });

  /*
   * Mark the final action of each independent
   * subassembly.
   */
  lastBuildStepBySubassembly.forEach(
    (step) => {
      if (
        step.phase === 'subassembly' ||
        step.phase === 'prepare'
      ) {
        step.subassemblyComplete = true;

        if (
          step.action !== 'integrate'
        ) {
          step.completionInstruction =
            `Sub-assembly complete: ${step.subassemblyName}. ` +
            `Set it aside until final integration.`;
        }
      }
    }
  );

  return steps;
}

// ---------------------------------------------------------------
// Main assembly planner
// ---------------------------------------------------------------

export function buildAssemblySequence(
  panels
) {
  const resolved =
    resolveConstraints(panels);

  const resolvedById =
    new Map(
      resolved.map((r) => [
        r.id,
        r,
      ])
    );

  const nameById =
    new Map(
      resolved.map((r) => [
        r.id,
        r.name || r.id,
      ])
    );

  const pieceCodeById =
    new Map(
      panels.map((p) => [
        p.id,
        p.pieceCode,
      ])
    );

  const codeOf = (id) =>
    pieceCodeById.get(id) ??
    nameById.get(id) ??
    id;

  const { joints } =
    detectJoints(resolved);

  const featureJoints =
    detectFeatureJoints(panels);

  const hardwarePlan =
    buildHardwarePlan(panels);

  /*
   * A closed door, or a drawer box sized to fit
   * snugly in its opening, can geometrically touch
   * the carcass without actually being structurally
   * screwed to it.
   *
   * FeatureJoints are the actual integration links.
   */
  const rawById =
    new Map(
      panels.map((p) => [
        p.id,
        p,
      ])
    );

  const isSameRigidUnit =
    (aId, bId) => {
      const a = rawById.get(aId);
      const b = rawById.get(bId);

      if (!a || !b) {
        return true;
      }

      /*
       * Doors never rigidly join the carcass.
       */
      if (
        a.isDoor ||
        b.isDoor
      ) {
        return false;
      }

      /*
       * Drawer front attachment is not modeled
       * as a structural joint yet.
       */
      if (
        a.isDrawerFront ||
        b.isDrawerFront
      ) {
        return false;
      }

      /*
       * Drawer box panels only join other panels
       * from the same drawer box.
       */
      if (
        a.isDrawerBoxPanel ||
        b.isDrawerBoxPanel
      ) {
        return (
          a.isDrawerBoxPanel &&
          b.isDrawerBoxPanel &&
          a.drawerBoxFrontId ===
            b.drawerBoxFrontId
        );
      }

      return true;
    };

  const structuralJoints =
    joints.filter(
      (j) =>
        STRUCTURAL_JOINT_TYPES.has(
          j.type
        ) &&
        isSameRigidUnit(
          j.panelA,
          j.panelB
        )
    );

  const integrationPanelIds =
    new Set(
      featureJoints.flatMap(
        (j) => [
          j.panelA,
          j.panelB,
        ]
      )
    );

  const visiblePanelIds =
    resolved
      .filter((p) => !p.hidden)
      .map((p) => p.id);

  const clusters =
    computeClusters(
      visiblePanelIds,
      structuralJoints
    );

  // -------------------------------------------------------------
  // Pre-install hardware
  // -------------------------------------------------------------

  const preInstallByPanel =
    new Map();

  const addPreInstall =
    (panelId, entry) => {
      if (
        !preInstallByPanel.has(panelId)
      ) {
        preInstallByPanel.set(
          panelId,
          []
        );
      }

      preInstallByPanel
        .get(panelId)
        .push(entry);
    };

  /*
   * Hinges:
   *   panelA = door
   *   panelB = carcass boundary
   */
  hardwarePlan.hinges.forEach(
    (h) => {
      addPreInstall(
        h.panelA,
        h
      );

      addPreInstall(
        h.panelB,
        h
      );
    }
  );

  /*
   * Runners:
   *   panelA = drawer side
   *   panelB = carcass side
   */
  hardwarePlan.runners.forEach(
    (r) => {
      addPreInstall(
        r.panelA,
        r
      );

      addPreInstall(
        r.panelB,
        r
      );
    }
  );

  const steps = [];

  let stepIndex = 1;

  /*
   * This map is initialized after clusterList is
   * created. emitStep closes over it safely because
   * it is invoked only afterward.
   */
  let clusterOfPanel = new Map();

  const pushStep =
    (partial) => {
      const primaryId =
        partial.panelIds?.[0];

      const sub =
        primaryId
          ? clusterOfPanel.get(
              primaryId
            )
          : null;

      const role =
        partial.role ??
        roleOfStepPanel(
          primaryId,
          rawById
        );

      const index =
        stepIndex++;

      const panelCodes =
        partial.panelIds.map(
          (id) => codeOf(id)
        );

      const instruction =
        partial.instruction ??
        humanInstruction({
          kind: partial.kind,
          phase: partial.phase,
          role,
          panelCode:
            panelCodes[0],
          otherCodes:
            partial.otherPanelIds
              ?.map(codeOf) || [],
          hardware:
            partial.hardware,
          description:
            partial.description,
        });

      steps.push({
        index,

        stepId:
          `S${String(index).padStart(2, '0')}`,

        panelNames:
          partial.panelIds.map(
            (id) =>
              nameById.get(id) ??
              '?'
          ),

        panelCodes,

        role,

        action:
          partial.action ??
          actionForStep(
            partial.kind,
            partial.phase,
            role
          ),

        subassemblyId:
          partial.subassemblyId ??
          sub?.id ??
          null,

        subassemblyName:
          partial.subassemblyName ??
          sub?.name ??
          null,

        instruction,

        warnings: [
          ...new Set([
            ...(partial.warnings || []),
            ...warningsForStep({
              kind: partial.kind,
              phase: partial.phase,
              role,
            }),
          ]),
        ],

        prerequisiteStepIds:
          partial.prerequisiteStepIds ||
          [],

        subassemblyComplete:
          false,

        completionInstruction:
          '',

        kind:
          partial.kind,

        phase:
          partial.phase,

        orientation:
          partial.orientation ??
          'unknown',

        requiresReposition:
          partial.requiresReposition ??
          false,

        repositionCost:
          partial.repositionCost ??
          0,

        panelIds:
          partial.panelIds,

        otherPanelIds:
          partial.otherPanelIds ||
          [],

        jointIds:
          partial.jointIds ||
          [],

        jointObjects:
          partial.jointObjects ||
          [],

        hardware:
          partial.hardware ||
          [],

        description:
          partial.description ||
          '',

        ergonomic:
          partial.ergonomic ||
          null,

        integrationSubassemblyIds:
          partial.integrationSubassemblyIds ||
          [],

        clusterKind:
          partial.clusterKind ||
          null,
      });
    };

  // -------------------------------------------------------------
  // Build semantic cluster list
  // -------------------------------------------------------------

  const clusterRoleCounts =
    new Map();

  const clusterList =
    clusters
      .map((cluster) => {
        const role =
          clusterRole(
            cluster,
            rawById
          );

        const ordinal =
          (
            clusterRoleCounts.get(
              role
            ) || 0
          ) + 1;

        clusterRoleCounts.set(
          role,
          ordinal
        );

        return {
          ids: cluster,

          role,

          ordinal,

          id:
            `SUB${String(
              clusters.indexOf(cluster) + 1
            ).padStart(2, '0')}`,

          name:
            subassemblyLabel(
              role,
              ordinal
            ),

          order:
            orderClusterPanelsPhase1(
              cluster,
              structuralJoints,
              resolvedById,
              codeOf,
              rawById
            ),
        };
      })
      .sort((a, b) => {
        /*
         * Hard subassembly ordering.
         */
        const pa =
          clusterPriority(
            a.role
          );

        const pb =
          clusterPriority(
            b.role
          );

        if (pa !== pb) {
          return pa - pb;
        }

        /*
         * Ergonomic optimization only within
         * otherwise equivalent subassembly classes.
         */
        const ea =
          ergonomicClusterScore(
            a.ids,
            rawById,
            resolvedById
          );

        const eb =
          ergonomicClusterScore(
            b.ids,
            rawById,
            resolvedById
          );

        if (ea !== eb) {
          return ea - eb;
        }

        if (
          b.ids.size !==
          a.ids.size
        ) {
          return (
            b.ids.size -
            a.ids.size
          );
        }

        const ca =
          codeOf(
            [...a.ids].sort()[0]
          );

        const cb =
          codeOf(
            [...b.ids].sort()[0]
          );

        return ca.localeCompare(cb);
      });

  /*
   * Panel → subassembly lookup.
   */
  clusterOfPanel =
    new Map();

  const subassemblyById =
    new Map();

  clusterList.forEach(
    ({
      ids,
      id,
      role,
      name,
    }) => {
      const meta = {
        id,
        role,
        name,
      };

      subassemblyById.set(
        id,
        meta
      );

      ids.forEach(
        (panelId) => {
          clusterOfPanel.set(
            panelId,
            {
              ids,
              ...meta,
            }
          );
        }
      );
    }
  );

  // -------------------------------------------------------------
  // Orientation / ergonomic state
  // -------------------------------------------------------------

  let assemblyOrientation =
    'flat';

  const repositionCostBetween =
    (from, to) => {
      if (
        !from ||
        !to ||
        from === to ||
        from === 'unknown' ||
        to === 'unknown'
      ) {
        return 0;
      }

      return 1;
    };

  /*
   * Emit wrapper that calculates Phase-2 ergonomics
   * and attaches Phase-3 semantic data.
   */
  const emitStep =
    (partial) => {
      const primaryId =
        partial.panelIds?.[0];

      const primaryPanel =
        rawById.get(
          primaryId
        );

      const primaryResolved =
        resolvedById.get(
          primaryId
        );

      const primaryRole =
        roleOfStepPanel(
          primaryId,
          rawById
        );

      const orientation =
        partial.orientation ??
        desiredOrientation(
          primaryRole
        );

      const repositionCost =
        repositionCostBetween(
          assemblyOrientation,
          orientation
        );

      const requiresReposition =
        repositionCost > 0;

      const ergonomic =
        ergonomicStepScore({
          panel: primaryPanel,
          resolved:
            primaryResolved,
          role: primaryRole,
          joints:
            partial.jointObjects ||
            [],
          orientation,
          fromOrientation:
            assemblyOrientation,
          kind:
            partial.kind,
        });

      ergonomic.reposition =
        Math.max(
          ergonomic.reposition,
          repositionCost * 2
        );

      ergonomic.score =
        Math.round(
          (
            ergonomic.score +
            repositionCost * 4
          ) * 10
        ) / 10;

      if (
        orientation !== 'unknown'
      ) {
        assemblyOrientation =
          orientation;
      }

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
          null,

        subassemblyName:
          partial.subassemblyName ??
          null,

        clusterKind:
          partial.clusterKind ??
          null,

        ...partial,
      });
    };

  // -------------------------------------------------------------
  // Build every independent subassembly
  // -------------------------------------------------------------

  clusterList.forEach(
    ({
      order,
      id: subassemblyId,
      name: subassemblyName,
      role: clusterKind,
    }) => {
      order.forEach(
        ({
          newPanel,
          joints: connectingJoints,
        }) => {
          const role =
            roleOfStepPanel(
              newPanel,
              rawById
            );

          const pre =
            preInstallByPanel.get(
              newPanel
            );

          /*
           * Panel-level hardware must be fitted
           * before the panel's first structural join.
           */
          if (pre) {
            pre.forEach(
              (hw) => {
                emitStep({
                  kind:
                    'pre_install',

                  phase:
                    'prepare',

                  panelIds:
                    [newPanel],

                  otherPanelIds:
                    [],

                  jointIds:
                    [],

                  hardware:
                    [hw],

                  orientation:
                    desiredOrientation(
                      role
                    ),

                  subassemblyId,

                  subassemblyName,

                  clusterKind,

                  description:
                    `Prepare ${codeOf(newPanel)} ` +
                    `with ${hw.hardware.brand ?? 'Generic'} ` +
                    `${hw.hardware.series ?? hw.hardware.kind} ` +
                    `hardware (${hw.displayId}) ` +
                    `before the panel joins the assembly.`,
                });
              }
            );
          }

          /*
           * First panel of a subassembly.
           */
          if (
            connectingJoints.length === 0
          ) {
            const clusterHasOtherPanels =
              order.length > 1;

            const hasKnownFutureRole =
              Boolean(pre) ||
              integrationPanelIds.has(
                newPanel
              );

            let description;

            if (
              clusterHasOtherPanels
            ) {
              description =
                `Start the ${
                  role === 'door'
                    ? 'door'
                    : role === 'drawer_box'
                      ? 'drawer'
                      : 'sub-assembly'
                } with ${codeOf(newPanel)}.`;
            } else if (
              hasKnownFutureRole
            ) {
              description =
                `Prepare ${codeOf(newPanel)} ` +
                `and set it aside ready for final integration.`;
            } else {
              description =
                `Place ${codeOf(newPanel)} — ` +
                `no structural joint or hardware association ` +
                `found for it yet (see the known-gap note).`;
            }

            emitStep({
              kind:
                clusterHasOtherPanels ||
                hasKnownFutureRole
                  ? 'join'
                  : 'unattached',

              phase:
                clusterHasOtherPanels ||
                hasKnownFutureRole
                  ? (
                      role === 'door' ||
                      role === 'drawer_box'
                        ? 'subassembly'
                        : 'internal'
                    )
                  : 'unattached',

              panelIds:
                [newPanel],

              otherPanelIds:
                [],

              jointIds:
                [],

              hardware:
                [],

              orientation:
                desiredOrientation(
                  role
                ),

              subassemblyId,

              subassemblyName,

              clusterKind,

              description,
            });
          } else {
            /*
             * Existing structural connection.
             */
            const fastenerEntries =
              hardwarePlan.fasteners.filter(
                (f) =>
                  connectingJoints.some(
                    (j) =>
                      j.id === f.jointId
                  )
              );

            const otherPanelIds =
              [
                ...new Set(
                  connectingJoints
                    .flatMap(
                      (j) => [
                        j.panelA,
                        j.panelB,
                      ]
                    )
                    .filter(
                      (id) =>
                        id !== newPanel
                    )
                ),
              ];

            const closure =
              role === 'back' ||
              role === 'top';

            emitStep({
              kind:
                'join',

              phase:
                closure
                  ? 'closure'
                  : (
                      role === 'vertical' ||
                      role === 'horizontal'
                    )
                      ? 'internal'
                      : 'subassembly',

              panelIds:
                [newPanel],

              otherPanelIds,

              jointIds:
                connectingJoints.map(
                  (j) => j.id
                ),

              hardware:
                fastenerEntries,

              jointObjects:
                connectingJoints,

              orientation:
                desiredOrientation(
                  role
                ),

              subassemblyId,

              subassemblyName,

              clusterKind,

              description:
                closure
                  ? (
                      `Install ${codeOf(newPanel)} ` +
                      `as a ${role} closure after all ` +
                      `accessible internal components are in place.`
                    )
                  : (
                      `Attach ${codeOf(newPanel)} ` +
                      `to ${otherPanelIds.map(codeOf).join(', ')} ` +
                      `(${connectingJoints.map((j) => j.type).join(', ')}).`
                    ),
            });
          }
        }
      );
    }
  );

  // -------------------------------------------------------------
  // Integration phase
  // -------------------------------------------------------------

  /*
   * Drawer slides.
   */
  const slideJoints =
    featureJoints.filter(
      (j) =>
        j.kind === 'drawer_slide'
    );

  const slideGroups =
    new Map();

  slideJoints.forEach(
    (j) => {
      const cluster =
        clusterOfPanel.get(
          j.panelA
        );

      const key =
        cluster?.ids ||
        cluster?.id ||
        j.panelA;

      if (
        !slideGroups.has(key)
      ) {
        slideGroups.set(
          key,
          {
            meta: cluster,
            joints: [],
          }
        );
      }

      slideGroups
        .get(key)
        .joints.push(j);
    }
  );

  slideGroups.forEach(
    ({
      meta,
      joints: groupJoints,
    }) => {
      const runnerEntries =
        hardwarePlan.runners.filter(
          (r) =>
            groupJoints.some(
              (j) =>
                j.id ===
                `${r.panelA}:${r.panelB}:slide`
            )
        );

      const drawerPanelIds =
        [
          ...new Set(
            groupJoints.map(
              (j) => j.panelA
            )
          ),
        ];

      const carcassPanelIds =
        [
          ...new Set(
            groupJoints.map(
              (j) => j.panelB
            )
          ),
        ];

      emitStep({
        kind:
          'integrate',

        phase:
          'integration',

        orientation:
          'upright',

        panelIds:
          [
            ...drawerPanelIds,
            ...carcassPanelIds,
          ],

        otherPanelIds:
          [],

        jointIds:
          groupJoints.map(
            (j) => j.id
          ),

        hardware:
          runnerEntries,

        jointObjects:
          groupJoints,

        subassemblyId:
          meta?.id ?? null,

        subassemblyName:
          meta?.name ??
          'Drawer assembly',

        integrationSubassemblyIds:
          [
            meta?.id,
            ...clusterList
              .filter(
                (c) =>
                  c.role === 'carcass'
              )
              .map(
                (c) => c.id
              ),
          ].filter(Boolean),

        description:
          `Slide the drawer box ` +
          `(${drawerPanelIds.map(codeOf).join(', ')}) ` +
          `into the carcass on its runners ` +
          `(${carcassPanelIds.map(codeOf).join(', ')}).`,
      });
    }
  );

  /*
   * Door hinges.
   */
  const hingeJoints =
    featureJoints.filter(
      (j) =>
        j.kind === 'door_hinge'
    );

  hingeJoints.forEach(
    (j) => {
      const hingeEntries =
        hardwarePlan.hinges.filter(
          (h) =>
            `${h.panelA}:hinge` ===
            j.id
        );

      const doorMeta =
        clusterOfPanel.get(
          j.panelA
        );

      const carcassMeta =
        clusterOfPanel.get(
          j.panelB
        );

      emitStep({
        kind:
          'integrate',

        phase:
          'integration',

        orientation:
          'upright',

        subassemblyId:
          doorMeta?.id ??
          null,

        subassemblyName:
          doorMeta?.name ??
          'Door assembly',

        integrationSubassemblyIds:
          [
            doorMeta?.id,
            carcassMeta?.id,
          ].filter(Boolean),

        panelIds:
          [
            j.panelA,
            j.panelB,
          ],

        otherPanelIds:
          [],

        jointIds:
          [j.id],

        hardware:
          hingeEntries,

        jointObjects:
          [j],

        description:
          `Hang ${codeOf(j.panelA)} ` +
          `on ${codeOf(j.panelB)} ` +
          `using the pre-fitted hinges.`,
      });
    }
  );

  // -------------------------------------------------------------
  // Finalize Phase-3 semantic model
  // -------------------------------------------------------------

  finalizeHumanReadableModel(
    steps
  );

  return {
    steps,

    clusters:
      clusterList.map(
        ({
          ids,
          id,
          role,
          name,
        }) => ({
          id,
          role,
          name,
          panelIds:
            [...ids],
        })
      ),

    phases: [
      {
        id: 'prepare',
        name: 'Prepare components',
      },

      {
        id: 'subassembly',
        name:
          'Build independent sub-assemblies',
      },

      {
        id: 'internal',
        name:
          'Build internal carcass components',
      },

      {
        id: 'closure',
        name:
          'Close the carcass',
      },

      {
        id: 'integration',
        name:
          'Final integration',
      },
    ],
  };
}

// ---------------------------------------------------------------
// Diagnostic / text renderer
// ---------------------------------------------------------------

/**
 * Plain-text rendering of the assembly sequence.
 *
 * Useful for debugging before PDF generation.
 */
export function formatAssemblySequenceLines(
  sequence
) {
  return sequence.steps.map(
    (s) => {
      const hwSuffix =
        s.hardware.length > 0
          ? `  [hardware: ${
              s.hardware
                .map(
                  (h) =>
                    h.displayId
                )
                .join(', ')
            }]`
          : '';

      const e =
        s.ergonomic;

      const ergoSuffix =
        e
          ? `  [ergo ${e.score}/100; ` +
            `reach ${e.reach}, ` +
            `tool ${e.toolAccess}, ` +
            `support ${e.support}, ` +
            `weight ${e.weight}, ` +
            `posture ${e.posture}, ` +
            `2P ${e.twoPerson}]`
          : '';

      const state =
        ` [${s.phase}; ` +
        `${s.action}; ` +
        `${s.orientation}` +
        `${
          s.requiresReposition
            ? '; reposition'
            : ''
        }]`;

      const sub =
        s.subassemblyName
          ? ` [${s.subassemblyName}]`
          : '';

      const prereq =
        s.prerequisiteStepIds?.length
          ? ` [after ${
              s.prerequisiteStepIds.join(
                ', '
              )
            }]`
          : '';

      const warning =
        s.warnings?.length
          ? ` [warning: ${
              s.warnings.join(
                ' | '
              )
            }]`
          : '';

      const complete =
        s.subassemblyComplete
          ? ` [COMPLETE: ${
              s.completionInstruction
            }]`
          : '';

      return (
        `${s.stepId}.` +
        `${sub}` +
        `${state}` +
        `${prereq}  ` +
        `${s.instruction || s.description}` +
        `${warning}` +
        `${complete}` +
        `${hwSuffix}` +
        `${ergoSuffix}`
      );
    }
  );
}
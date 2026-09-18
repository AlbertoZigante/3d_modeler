/**
 * engine/ergonomics.js — TOOL IDENTIFICATION + ERGONOMICS SCORING
 * (Phases 2 and 3 of the assembly plan).
 *
 * This is an ANNOTATION pass over engine/assembly.js#buildAssemblySequence's
 * output, not a second sequencer — exactly as scoped originally: neither
 * phase invents a new ordering, both just attach information to the
 * order buildAssemblySequence already computed. `buildAssemblyPlan`
 * below ties sequencing + tools + ergonomics into one call, the same
 * "one entry point, same shape" pattern as buildJointsReport and
 * buildHardwarePlan.
 *
 * PHASE 2 — TOOLS
 * -----------------
 * A step's tools are the union of tools its hardware needs — trivial
 * once buildHardwarePlan's per-item `kind` exists (see TOOL_CATALOG).
 * The confirmat screw drive type is NOT a verified spec the way the
 * Blum numbers in engine/hardware.js are — flagged as a convention to
 * confirm per actual screw brand, not cited as fact.
 *
 * PHASE 3 — ERGONOMICS
 * -----------------------
 * Three concrete, computable checks per step, matching the original
 * plan's own scoping (flip-count, cantilever/support, two-person):
 *
 *   1. weightKg / twoPersonJob — cumulative weight of whatever
 *      physical object this step is building, tracked with a simple
 *      union-find over panels as they get joined/integrated (so a
 *      drawer box's weight and the carcass's weight stay separate
 *      until the integrate step that actually combines them).
 *      Weight is estimated from panel volume x an assumed material
 *      density — NOT looked up from MATERIAL_CATALOG, which has no
 *      density field (see DEFAULT_MATERIAL_DENSITY_KG_PER_M3's own
 *      comment). This is an approximation, called out as such.
 *   2. singleJointCaution — a join step secured by only ONE
 *      structural joint is inherently less stable the instant it's
 *      placed (nothing else is holding its far end) — flagged so a
 *      person knows to support/clamp it before fastening, rather than
 *      trusting the single joint to hold it up alone.
 *   3. orientationAxis / reorientationNeeded — which axis should face
 *      up for this step's fastening to be driven with gravity's help
 *      rather than against it, and whether that differs from the
 *      previous step (meaning the assembly needs to be flipped).
 *      ASSUMPTION, stated plainly: this assumes a fastener is driven
 *      ALONG the joint's own contact axis — the real fastening
 *      DIRECTION (which of the two panels the screw actually goes
 *      through) isn't modeled yet, the same open problem flagged all
 *      the way back when detectJoints was first designed. Only
 *      applies to 'join' steps — a drawer slide-in or a door hang has
 *      no meaningful "which way is up" requirement of its own.
 */
import { resolveConstraints } from '../modeller/snap.js';
import { buildAssemblySequence } from './assembly.js';

// ---------------------------------------------------------------
// TOOLS
// ---------------------------------------------------------------
export const TOOL_CATALOG = {
  concealed_hinge: {
    tools: ['Phillips/PZ2 screwdriver (or drill/driver)'],
    note: 'Cup + fixing-hole boring is typically pre-drilled by the panel manufacturer; if boring it yourself, use a 35mm Forstner bit at the cup depth/edge distance from the hardware spec, ideally with a drill press or boring jig for accuracy.',
  },
  drawer_runner_wood_screw: {
    tools: ['Phillips/PZ2 screwdriver (or drill/driver)'],
    note: "TANDEM mounts through its own elongated holes; LEGRABOX's 612TH screw is self-tapping. Neither needs a separate pilot hole per Blum's own installation instructions.",
  },
  confirmat_screw: {
    tools: [
      '4.5mm drill bit (pilot hole)',
      '7mm drill bit or a stepped confirmat bit (clearance hole)',
      'Pozidriv PZ3 screwdriver bit (or drill/driver)',
    ],
    note: 'Requires a proper two-stage pilot + clearance hole (see the catalog entry\'s own pilotHoleDiameterMm/clearanceHoleDiameterMm) or the panel will split. Drive type (Pozidriv PZ3 here) is a common convention, not a verified spec — confirm against your specific confirmat screw brand.',
  },
};

/**
 * Maps one buildHardwarePlan entry (a hinge/runner/fastener) to a
 * TOOL_CATALOG key. Kept as a dispatcher rather than a static field on
 * each hardware entry so a future new PANEL_CONNECTOR_CATALOG kind
 * (e.g. a cam lock) just needs a new TOOL_CATALOG key, not a change to
 * every existing catalog entry.
 */
function toolKeyForHardwareItem(item) {
  if (item.kind === 'hinge') return 'concealed_hinge';
  if (item.kind === 'runner') return 'drawer_runner_wood_screw';
  if (item.kind === 'fastener') return item.hardware.kind ?? 'confirmat_screw';
  return null;
}

/**
 * Attaches a `tools` field (deduped tool strings) to every step, plus
 * an overall `toolsSummary` (the union across the whole sequence) —
 * the IKEA-style "tools needed" cover-page list.
 *
 * @param {ReturnType<typeof buildAssemblySequence>} sequence
 * @returns {{ steps: object[], toolsSummary: string[] }}
 */
export function annotateStepsWithTools(sequence) {
  const allTools = new Set();
  const steps = sequence.steps.map((step) => {
    const toolKeys = [...new Set(step.hardware.map(toolKeyForHardwareItem).filter(Boolean))];
    const tools = [...new Set(toolKeys.flatMap((key) => TOOL_CATALOG[key]?.tools ?? []))];
    const notes = toolKeys.map((key) => TOOL_CATALOG[key]?.note).filter(Boolean);
    tools.forEach((t) => allTools.add(t));
    return { ...step, tools, toolNotes: notes };
  });
  return { steps, toolsSummary: [...allTools] };
}

// ---------------------------------------------------------------
// ERGONOMICS
// ---------------------------------------------------------------

// Melamine-faced particleboard/MDF density is commonly cited around
// 600-700 kg/m3; 650 is a reasonable midpoint. This is an
// APPROXIMATION — MATERIAL_CATALOG (modules.js) has no density field
// to look up per-material, so every panel uses this one constant
// regardless of its actual assigned material. Revisit if/when
// MATERIAL_CATALOG grows a real density column.
const DEFAULT_MATERIAL_DENSITY_KG_PER_M3 = 650;

// Common manual-handling guidance (e.g. HSE-style lifting/carrying
// tables) treats roughly 20-25kg as a reasonable single-person limit
// for a bulky, awkward-to-grip object like a panel assembly — not a
// Blum spec, a general rule of thumb.
const TWO_PERSON_THRESHOLD_KG = 20;
// Below this, comfortable to build on a table; at or above, floor space
// is the more realistic working surface.
const FLOOR_SURFACE_THRESHOLD_KG = 10;

function panelWeightKg(resolvedPanel) {
  if (!resolvedPanel) return 0;
  const volumeM3 = (resolvedPanel.thickness / 1000) * (resolvedPanel.width / 1000) * (resolvedPanel.height / 1000);
  return volumeM3 * DEFAULT_MATERIAL_DENSITY_KG_PER_M3;
}

// Minimal union-find: merges panel ids into groups as steps join them,
// so "how heavy is the physical object in your hands right now" stays
// correct across sub-assemblies that haven't been integrated yet (a
// drawer box's weight and the carcass's weight are tracked separately
// until the step that actually slides one into the other).
class PanelGroups {
  constructor() {
    this.parent = new Map();
  }
  find(id) {
    if (!this.parent.has(id)) this.parent.set(id, id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // path compression
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(ids) {
    const roots = ids.map((id) => this.find(id));
    const [first, ...rest] = roots;
    rest.forEach((r) => { if (r !== first) this.parent.set(r, first); });
  }
  membersOf(id) {
    const root = this.find(id);
    return [...this.parent.keys()].filter((k) => this.find(k) === root);
  }
}

/**
 * Determines the "up" axis for a join step's fastening — see this
 * file's header for the stated assumption (fastener driven along the
 * joint's own contact axis). Returns null when the connecting joints
 * don't all share one axis (a mixed step has no single clean
 * orientation to call out).
 */
function orientationAxisForJoints(joints) {
  const axes = new Set(joints.map((j) => j.contactAxis));
  return axes.size === 1 ? [...axes][0] : null;
}

/**
 * Annotates every step with an `ergonomics` object:
 *   - weightKg, twoPersonJob, recommendedSurface
 *   - singleJointCaution (join steps only)
 *   - orientationAxis, reorientationNeeded (join steps only)
 *
 * @param {Array} panels - RAW graph (not resolved)
 * @param {ReturnType<typeof buildAssemblySequence>} sequence
 * @returns {{ steps: object[] }}
 */
export function scoreErgonomics(panels, sequence) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const groups = new PanelGroups();
  const lastOrientationByRoot = new Map();

  const steps = sequence.steps.map((step) => {
    // Establish/merge this step's group membership.
    if (step.kind === 'join' && step.otherPanelIds.length > 0) {
      groups.union([...step.panelIds, ...step.otherPanelIds]);
    } else if (step.kind === 'integrate') {
      groups.union(step.panelIds);
    } else {
      // pre_install / anchor-or-unattached 'join' / anything else: no
      // merge, but make sure the panel(s) exist in the structure so
      // find()/membersOf() below don't need a special case for them.
      step.panelIds.forEach((id) => groups.find(id));
    }

    const referencePanelId = step.panelIds[0];
    const memberIds = referencePanelId ? groups.membersOf(referencePanelId) : [];
    const weightKg = Math.round(memberIds.reduce((sum, id) => sum + panelWeightKg(resolvedById.get(id)), 0) * 10) / 10;
    const twoPersonJob = weightKg >= TWO_PERSON_THRESHOLD_KG;
    const recommendedSurface = weightKg >= FLOOR_SURFACE_THRESHOLD_KG ? 'floor' : 'table';

    const ergonomics = { weightKg, twoPersonJob, recommendedSurface };

    if (step.kind === 'join' && step.jointIds.length > 0) {
      ergonomics.singleJointCaution = step.jointIds.length === 1;

      const connectingJoints = step.jointIds.map((id) => ({ contactAxis: id.split(':')[2] })); // jointId format is `${panelA}:${panelB}:${axis}` — see detectJoints
      const orientationAxis = orientationAxisForJoints(connectingJoints);
      ergonomics.orientationAxis = orientationAxis;

      const root = groups.find(referencePanelId);
      const previousOrientation = lastOrientationByRoot.get(root);
      ergonomics.reorientationNeeded = !!(
        orientationAxis && previousOrientation && previousOrientation !== orientationAxis
      );
      if (orientationAxis) lastOrientationByRoot.set(root, orientationAxis);
    }

    return { ...step, ergonomics };
  });

  return { steps };
}

/**
 * Ties buildAssemblySequence + tool annotation + ergonomics scoring
 * into one pass — the assembly-layer equivalent of buildJointsReport/
 * buildHardwarePlan. Pure function, nothing persisted, recomputed
 * fresh on every call like everything else in this pipeline.
 *
 * @param {Array} panels - RAW graph (not resolved)
 * @returns {{ steps: object[], clusters: object[], toolsSummary: string[] }}
 */
export function buildAssemblyPlan(panels) {
  const sequence = buildAssemblySequence(panels);
  const withTools = annotateStepsWithTools(sequence);
  const withErgonomics = scoreErgonomics(panels, { steps: withTools.steps });
  // Merge the two annotation passes' per-step additions back together —
  // both read from the same original step list, so index-aligned zip.
  const steps = withTools.steps.map((step, i) => ({ ...step, ergonomics: withErgonomics.steps[i].ergonomics }));
  return { steps, clusters: sequence.clusters, toolsSummary: withTools.toolsSummary };
}

/**
 * Plain-text rendering — same "print and eyeball" convention as
 * engine/assembly.js#formatAssemblySequenceLines, extended with tools
 * and ergonomics flags.
 *
 * @param {ReturnType<typeof buildAssemblyPlan>} plan
 * @returns {string[]}
 */
export function formatAssemblyPlanLines(plan) {
  const lines = [];
  if (plan.toolsSummary.length > 0) {
    lines.push('=== TOOLS NEEDED ===', ...plan.toolsSummary.map((t) => `- ${t}`), '');
  }
  plan.steps.forEach((s) => {
    const hwSuffix = s.hardware.length > 0 ? `  [hardware: ${s.hardware.map((h) => h.displayId).join(', ')}]` : '';
    const toolSuffix = s.tools.length > 0 ? `  [tools: ${s.tools.join(', ')}]` : '';
    const flags = [];
    if (s.ergonomics.twoPersonJob) flags.push('TWO-PERSON JOB');
    if (s.ergonomics.singleJointCaution) flags.push('single-joint, support it');
    if (s.ergonomics.reorientationNeeded) flags.push(`flip so ${s.ergonomics.orientationAxis?.toUpperCase()} faces up`);
    const flagSuffix = flags.length > 0 ? `  ⚠ ${flags.join('; ')}` : '';
    lines.push(
      `${String(s.index).padStart(2, '0')}. (${s.kind})  ${s.description}` +
      `  [~${s.ergonomics.weightKg}kg, ${s.ergonomics.recommendedSurface}]${hwSuffix}${toolSuffix}${flagSuffix}`
    );
  });
  return lines;
}

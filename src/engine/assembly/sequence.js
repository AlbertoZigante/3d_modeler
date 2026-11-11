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
 *
 * STAGE ORDER (what happens before what)
 * ----------------------------------------
 * Whatever the carcass looks like, the build always runs in this order
 * (see stages/index.js — one file per stage):
 *   1. doors        door panels (+ hinge cups), then their handles
 *   2. drawers      drawer boxes (+ runner half on the box sides), drawer
 *                   fronts, then their handles
 *   3. guides       carcass-side drawer guides, mounted on the loose
 *                   side / shelf panels
 *   4. plinth       plinth panels, built as their own frame
 *   5. carcass      the remaining furniture (bottom -> verticals ->
 *                   shelves -> back -> top)
 *   6. integration  plinth fitted, drawers slid in, doors hung
 * Each step carries a `stage` field with one of these ids; the existing
 * `phase` field (prepare/subassembly/internal/closure/integration) is
 * unchanged so the PDF layer keeps working as before.
 */
import { finalizeHumanReadableModel } from './humanModel.js';
import { createAssemblyContext } from './context.js';
import { createStepEmitter } from './stepEmitter.js';
import { STAGES } from './stages/index.js';

/**
 * @typedef {Object} AssemblyStep
 * @property {number} index - 1-based order in the final sequence
 * @property {'doors'|'drawers'|'guides'|'plinth'|'carcass'|'integration'} stage - coarse build stage, see stages/index.js
 * @property {'pre_install'|'fit_handle'|'join'|'integrate'|'unattached'} kind
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
export function buildAssemblySequence(panels) {
  const ctx = createAssemblyContext(panels);
  const emitter = createStepEmitter(ctx);
  ctx.emitStep = emitter.emitStep;

  STAGES.forEach((stage) => {
    emitter.setStage(stage.id);
    stage.run(ctx);
  });

  finalizeHumanReadableModel(emitter.steps);

  return {
    steps: emitter.steps,
    clusters: ctx.clusterList.map(({ ids, id, role, name }) => ({
      id, role, name, panelIds: [...ids],
    })),
    stages: STAGES.map(({ id, name }) => ({ id, name })),
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

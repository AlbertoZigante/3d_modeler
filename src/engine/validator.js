/**
 * engine/validator.js
 *
 * A whole-design audit, run once per render alongside
 * engine/joints.js#detectJoints. This is deliberately NOT where the
 * "can this specific edit happen" checks live — those already exist,
 * inline, at the moment of the interaction (see
 * shared/geometry.js#findPanelSizeViolation / findDesignLimitViolation
 * / checkMinGap, called directly from features/box.js#relayoutBox,
 * tools/collinearTool.js, and the resize/drag handlers in
 * modeller-main.js). That's where a bad edit gets clamped or rejected
 * on the spot, with the person's hand still on the mouse.
 *
 * This file exists for the violations that CAN'T be caught that way:
 * ones that only exist in relation to the WHOLE resolved graph, not
 * any single proposed edit — most obviously two panels that end up
 * overlapping in space because of an edit made somewhere else
 * entirely. It also re-sweeps every panel's own size/position limits
 * as a backstop, in case an indirect cascade (a panel resizing
 * because something it's constrained to moved) produced an invalid
 * state without ever going through one of the direct interactive
 * paths above.
 *
 * Same principle as engine/joints.js's own collisions field and
 * modeller-main.js#checkJointWarnings (orphans / cross-group joints):
 * detect and surface, never silently block. A collision or an
 * out-of-bounds panel is very often a transient mid-drag state that
 * resolves itself the moment the person finishes the edit — hard-
 * blocking renderAll() over it would trap them in a state they can't
 * see well enough to fix.
 */

import { detectJoints } from './joints.js';
import { findPanelSizeViolation, findDesignLimitViolation, checkMinGap, collectAxisSlabs } from '../shared/geometry.js';
import { MIN_PANEL_DIM_MM } from '../modeller/modules.js';

/**
 * @typedef {Object} Violation
 * @property {'collision'|'undersizedPanel'|'oversizedPanel'|'exceedsDesignLimit'|'minGap'} type
 * @property {string} key - stable across renders for the SAME underlying issue, so a caller
 *   (see modeller-main.js) can toast only on first appearance, not every frame it persists.
 * @property {string[]} panelIds
 * @property {string} message
 */

function displayName(panel) {
  return panel.name || panel.id;
}

/**
 * Collisions are read straight off engine/joints.js#detectJoints's own
 * output rather than re-derived here — detectJoints already computes
 * one AABB overlap test per panel pair every render (see
 * modeller-main.js#checkJointWarnings, which runs it unconditionally),
 * so a second full pairwise pass here would just repeat that work
 * for the same answer.
 *
 * @param {import('./joints.js').Collision[]} collisions
 * @param {Map<string, object>} resolvedById
 */
function collisionViolations(collisions, resolvedById) {
  return collisions.map((c) => {
    const a = resolvedById.get(c.panelA);
    const b = resolvedById.get(c.panelB);
    return {
      type: 'collision',
      key: `collision:${[c.panelA, c.panelB].sort().join('|')}`,
      panelIds: [c.panelA, c.panelB],
      message: `${a ? displayName(a) : c.panelA} and ${b ? displayName(b) : c.panelB} are overlapping in space, not just touching.`,
    };
  });
}

/**
 * Whole-design backstop for per-panel size limits — MIN_PANEL_DIM_MM
 * (too thin/short: currently only enforced inline inside
 * features/box.js#relayoutBox's own wall-resize path) and
 * PANEL_SIZE_LIMITS_MM's max width/height (already enforced at every
 * direct resize entry point — see findPanelSizeViolation's own
 * comment — this just re-confirms nothing slipped through indirectly).
 *
 * @param {Array} visibleResolvedPanels
 */
function panelSizeViolations(visibleResolvedPanels) {
  const violations = [];
  visibleResolvedPanels.forEach((panel) => {
    const dims = { width: panel.width, height: panel.height, thickness: panel.thickness };

    if (dims.width < MIN_PANEL_DIM_MM || dims.height < MIN_PANEL_DIM_MM) {
      violations.push({
        type: 'undersizedPanel',
        key: `undersizedPanel:${panel.id}`,
        panelIds: [panel.id],
        message: `${displayName(panel)} is thinner than the ${MIN_PANEL_DIM_MM}mm minimum (${dims.width.toFixed(0)} × ${dims.height.toFixed(0)}mm).`,
      });
      return; // an undersized panel isn't also worth reporting as oversized
    }

    const oversizedField = findPanelSizeViolation(dims);
    if (oversizedField) {
      violations.push({
        type: 'oversizedPanel',
        key: `oversizedPanel:${panel.id}:${oversizedField}`,
        panelIds: [panel.id],
        message: `${displayName(panel)}'s ${oversizedField} exceeds the panel size limit.`,
      });
    }
  });
  return violations;
}

/**
 * Whole-design backstop for DESIGN_LIMITS_MM — the overall space a
 * design may occupy (see modeller/modules.js's own comment on it).
 * This is what "too tall furniture" actually is: a panel whose
 * resolved Y extent pushes past DESIGN_LIMITS_MM.y.max.
 *
 * @param {Array} visibleResolvedPanels
 */
function designLimitViolations(visibleResolvedPanels) {
  const violations = [];
  visibleResolvedPanels.forEach((panel) => {
    const dims = { width: panel.width, height: panel.height, thickness: panel.thickness };
    const axis = findDesignLimitViolation(panel.rotation, panel.position, dims);
    if (axis) {
      const axisLabel = axis === 'y' ? 'height' : axis === 'x' ? 'width' : 'depth';
      violations.push({
        type: 'exceedsDesignLimit',
        key: `exceedsDesignLimit:${panel.id}:${axis}`,
        panelIds: [panel.id],
        message: `${displayName(panel)} exceeds the design's overall ${axisLabel} limit.`,
      });
    }
  });
  return violations;
}

/**
 * Whole-design backstop for MIN_WALL_GAP_MM (see
 * shared/geometry.js#checkMinGap) — "too close shelves", swept across
 * EVERY group and both axes rather than just the one group/axis a
 * direct drag happens to be touching (see relayoutBox's own call for
 * the interactive, single-drag version of this same check).
 *
 * Operates on the RAW graph (`panels`), not resolved output —
 * collectAxisSlabs reads each panel's own `.offset` field, which only
 * exists pre-resolve (see collectAxisSlabs's own comment on why
 * doors/drawer fronts/drawer box panels are excluded from this
 * heuristic entirely).
 *
 * @param {Array} panels - raw graph
 */
function minGapViolations(panels) {
  const violations = [];
  const groupIds = new Set(panels.filter((p) => p.groupId && !p.hidden).map((p) => p.groupId));

  groupIds.forEach((groupId) => {
    ['x', 'y'].forEach((axis) => {
      const slabs = collectAxisSlabs(panels, groupId, axis);
      const result = checkMinGap(slabs);
      if (!result.ok) {
        violations.push({
          type: 'minGap',
          key: `minGap:${groupId}:${axis}:${[result.a, result.b].sort().join('|')}`,
          panelIds: [], // checkMinGap reports slab labels, not panel ids — see its own {ok,a,b} shape
          message: `${result.a} and ${result.b} are closer together than the minimum gap allows.`,
        });
      }
    });
  });

  return violations;
}

/**
 * @param {Array} panels - raw graph (needed for the min-gap sweep)
 * @param {Array} resolvedPanels - resolved graph (needed for collisions/size/design-limit sweeps)
 * @param {{joints?: import('./joints.js').Joint[], collisions?: import('./joints.js').Collision[]}} [precomputed] -
 *   pass the SAME detectJoints() result modeller-main.js#checkJointWarnings already computed this
 *   render, to avoid a second full O(panel count²) pass for the same answer. Computed fresh if omitted.
 * @returns {{ violations: Violation[] }}
 */
export function validateDesign(panels, resolvedPanels, precomputed = {}) {
  const visibleResolvedPanels = resolvedPanels.filter((p) => !p.hidden);
  const resolvedById = new Map(resolvedPanels.map((p) => [p.id, p]));

  const collisions = precomputed.collisions ?? detectJoints(resolvedPanels).collisions;

  return {
    violations: [
      ...collisionViolations(collisions, resolvedById),
      ...panelSizeViolations(visibleResolvedPanels),
      ...designLimitViolations(visibleResolvedPanels),
      ...minGapViolations(panels),
    ],
  };
}

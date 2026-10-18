/**
 * engine/quoteConflicts.js
 *
 * Whole-design audit of USER QUOTES (`distance` constraints, see
 * engine/quotes.js). engine/quotes.js#addQuote already refuses the
 * simple cases at the moment a quote is typed; this file catches what
 * only shows up later or in combination — another quote added on the
 * same panel from a loaded design, a panel whose axis got locked, an
 * anchor that was deleted or rotated, or (most commonly) a stack of
 * quotes that no longer fits in the space around it.
 *
 * Same principle as engine/validator.js: DETECT AND SURFACE, never
 * silently block. Every violation has `type: 'quoteConflict'` and a
 * `kind`:
 *
 *   overDriven    — two or more relations drive the same panel position
 *   systemDriven  — a quote drives a system-owned panel (plinth, door…)
 *   axisLocked    — a quote drives an axis the panel can't move on
 *   unresolved    — the resolver couldn't apply it (missing/rotated
 *                   anchor, cycle…) — carries the resolver's own text
 *   unsatisfied   — the panel isn't at the quoted distance
 *   overflow      — the quote(s) push the panel into another panel, or
 *                   past the design's overall limits (typical cause: a
 *                   stack of quoted shelves taller than the interior)
 *
 * `drivenIds` lists the quoted panels involved (the overlay turns
 * their dimension lines red). `explains` lists keys of generic
 * validator violations this one already accounts for, so
 * validateDesign can drop the duplicates.
 */
import {
  FIELD_TO_AXIS,
  FACE_TO_DIM_FIELD,
  getAlignedAxis,
  getPanelOwnership,
  computeWorldHalfExtents,
} from '../modeller/modules.js';
import { findDesignLimitViolation } from '../shared/geometry.js';

const TOL_MM = 0.5;

const name = (p) => p?.name || p?.id;

function activeQuotes(panels) {
  const out = [];
  panels.forEach((p) => {
    (p.constraints || []).forEach((c) => {
      if (c.type === 'distance' && !c.overridden) out.push({ panel: p, c });
    });
  });
  return out;
}

/**
 * @param {Array} panels - raw graph
 * @param {Array} resolvedPanels - resolved graph (same ids)
 * @param {{collisions?: Array}} [precomputed] - detectJoints()'s collisions, to avoid a second pairwise pass
 * @returns {Array} violations (shape: see validator.js#Violation, plus kind/drivenIds/explains)
 */
export function findQuoteConflicts(panels, resolvedPanels, precomputed = {}) {
  const quotes = activeQuotes(panels);
  if (quotes.length === 0) return [];

  const resolvedById = new Map(resolvedPanels.map((r) => [r.id, r]));
  const violations = [];
  const flaggedFields = new Set(); // `${panelId}:${field}` already reported as overDriven

  // 1. several relations driving one position field ----------------
  const byField = new Map();
  panels.forEach((p) => {
    (p.constraints || []).forEach((c) => {
      if (c.overridden || !String(c.field || '').startsWith('position')) return;
      const k = `${p.id}:${c.field}`;
      if (!byField.has(k)) byField.set(k, { panel: p, field: c.field, list: [] });
      byField.get(k).list.push(c);
    });
  });
  byField.forEach(({ panel, field, list }, k) => {
    if (list.length < 2 || !list.some((c) => c.type === 'distance')) return;
    flaggedFields.add(k);
    const axis = FIELD_TO_AXIS[field].toUpperCase();
    violations.push({
      type: 'quoteConflict', kind: 'overDriven',
      key: `quoteConflict:overDriven:${k}`,
      panelIds: [panel.id],
      drivenIds: [panel.id],
      message: `${name(panel)}'s ${axis} position is controlled by ${list.length} relations at once — only one can apply. Remove or unlink the extra dimension.`,
    });
  });

  quotes.forEach(({ panel, c }) => {
    const axis = FIELD_TO_AXIS[c.field];
    const r = resolvedById.get(panel.id);
    const anchor = resolvedById.get(c.from?.node);
    const base = { type: 'quoteConflict', panelIds: [panel.id, c.from?.node].filter(Boolean), drivenIds: [panel.id] };

    // 2. system-owned / locked axis -------------------------------
    if (getPanelOwnership(panel).ownership === 'system') {
      violations.push({
        ...base, kind: 'systemDriven', key: `quoteConflict:systemDriven:${c.id}`,
        message: `${name(panel)} is managed by the system and can't be positioned by a dimension.`,
      });
    } else if ((panel.lockedMoveAxes || []).includes(axis)) {
      violations.push({
        ...base, kind: 'axisLocked', key: `quoteConflict:axisLocked:${c.id}`,
        message: `${name(panel)} can't move along ${axis.toUpperCase()}, so its dimension can't be applied.`,
      });
    }

    // 3. resolver could not apply it ------------------------------
    if (!r || !anchor) {
      violations.push({
        ...base, kind: 'unresolved', key: `quoteConflict:unresolved:${c.id}`,
        message: `A dimension on ${name(panel)} refers to a panel that no longer exists.`,
      });
      return;
    }
    if (r.warnings.length) {
      violations.push({
        ...base, kind: 'unresolved', key: `quoteConflict:unresolved:${c.id}`,
        message: `Dimension ${name(panel)} ↔ ${name(anchor)} can't be applied: ${r.warnings[0]}.`,
      });
      return;
    }

    // 4. not at the quoted distance ------------------------------
    const aAl = getAlignedAxis(anchor.rotation, c.from.face);
    const mAl = getAlignedAxis(r.rotation, c.myFace);
    if (aAl && mAl && aAl.axis === axis && mAl.axis === axis && !flaggedFields.has(`${panel.id}:${c.field}`)) {
      const aMm = anchor.position[axis] + aAl.sign * (anchor[FACE_TO_DIM_FIELD[c.from.face]] / 2);
      const mMm = r.position[axis] + mAl.sign * (r[FACE_TO_DIM_FIELD[c.myFace]] / 2);
      const actual = (mMm - aMm) * aAl.sign;
      if (Math.abs(actual - c.value) > TOL_MM) {
        violations.push({
          ...base, kind: 'unsatisfied', key: `quoteConflict:unsatisfied:${c.id}`,
          message: `${name(panel)} should be ${round(c.value)} mm from ${name(anchor)} but is ${round(actual)} mm — something else is overriding the dimension.`,
        });
      }
    }

    // 5. does the result still fit? -------------------------------
    if (r.hidden) return;
    const dims = { width: r.width, height: r.height, thickness: r.thickness };
    const limitAxis = findDesignLimitViolation(r.rotation, r.position, dims);
    if (limitAxis) {
      const label = limitAxis === 'y' ? 'height' : limitAxis === 'x' ? 'width' : 'depth';
      violations.push({
        ...base, kind: 'overflow', key: `quoteConflict:overflow:${c.id}:limit`,
        explains: [`exceedsDesignLimit:${panel.id}:${limitAxis}`],
        message: `Dimension ${name(panel)} ↔ ${name(anchor)} (${round(c.value)} mm) pushes ${name(panel)} past the design's overall ${label} limit.`,
      });
    }
  });

  // 5b. overlaps caused by a quoted panel (reuse detectJoints' collisions) --
  const drivenIds = new Set(quotes.map(({ panel }) => panel.id));
  (precomputed.collisions || []).forEach((col) => {
    const driven = drivenIds.has(col.panelA) ? col.panelA : drivenIds.has(col.panelB) ? col.panelB : null;
    if (!driven) return;
    const otherId = driven === col.panelA ? col.panelB : col.panelA;
    const d = resolvedById.get(driven);
    const o = resolvedById.get(otherId);
    if (!d || !o) return;
    const q = quotes.find(({ panel }) => panel.id === driven);
    const axis = FIELD_TO_AXIS[q.c.field];
    const hd = computeWorldHalfExtents(d);
    const ho = computeWorldHalfExtents(o);
    const depth = Math.min(d.position[axis] + hd[axis], o.position[axis] + ho[axis])
      - Math.max(d.position[axis] - hd[axis], o.position[axis] - ho[axis]);
    violations.push({
      type: 'quoteConflict', kind: 'overflow',
      key: `quoteConflict:overflow:${[driven, otherId].sort().join('|')}`,
      panelIds: [driven, otherId], drivenIds: [driven],
      explains: [`collision:${[col.panelA, col.panelB].sort().join('|')}`],
      message: `The dimension on ${name(d)} puts it inside ${name(o)}${depth > TOL_MM ? ` by about ${round(depth)} mm` : ''} — the quoted distances don't fit the space available; reduce them.`,
    });
  });

  return violations;
}

function round(n) {
  return Math.round(n * 10) / 10;
}
